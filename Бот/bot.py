import os
import json
import asyncio
import queue
import threading
import traceback
from datetime import datetime, timedelta
from flask import Flask, request
from telegram import Update, Bot, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes
import google.generativeai as genai
from dotenv import load_dotenv
import assemblyai as aai

# Загружаем переменные окружения из .env файла
load_dotenv()

# Токены
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GEMINI_KEY = os.getenv("GEMINI_KEY")
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")
WEBHOOK_URL = os.getenv("RENDER_EXTERNAL_URL", "https://rozysk-avto-bot.onrender.com") + "/webhook"

# Диагностика ключей
print(f"🔍 TELEGRAM_TOKEN: {'OK' if TELEGRAM_TOKEN else 'MISSING'}")
print(f"🔍 GEMINI_KEY: {'OK (' + str(len(GEMINI_KEY)) + ' chars)' if GEMINI_KEY else 'MISSING'}")
print(f"🔍 ASSEMBLYAI_API_KEY: {'OK' if ASSEMBLYAI_API_KEY else 'MISSING'}")
print(f"🔍 WEBHOOK_URL: {WEBHOOK_URL}")

# Настройка Gemini
genai.configure(api_key=GEMINI_KEY)
model = genai.GenerativeModel('gemini-2.0-flash-lite')

# Настройка AssemblyAI
if ASSEMBLYAI_API_KEY:
    aai.settings.api_key = ASSEMBLYAI_API_KEY

app = Flask(__name__)

# Хранилище задач с историей
user_tasks = {}
user_history = {}
update_queue = queue.Queue()
application = None
bot_loop = None
timer_tasks = {}

# Функция для загрузки промптов из файлов
def load_prompt(filename):
    """Загружает промпт из файла prompts/"""
    try:
        prompt_path = os.path.join(os.path.dirname(__file__), 'prompts', filename)
        with open(prompt_path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        print(f"⚠️ Prompt file not found: {filename}")
        return None

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    print(f"📥 /start command from user {update.effective_user.id}")
    await update.message.reply_text(
        "Бывает, большая задача ставит в тупик, и непонятно, с чего начать. Хочется отложить её на потом, но лучший способ обрести ясность — просто начать действовать\n\n"
        "Напиши или скажи голосом, какая у тебя задача, и я разобью её на простые, короткие этапы с таймером\n\n"
        "Например: «подготовиться к собеседованию» или «убраться в квартире»"
    )

async def handle_task(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id

    # Debug: выводим информацию о типе сообщения
    print(f"🔍 handle_task called from user {user_id}")
    print(f"🔍 Message type - text: {update.message.text is not None}, voice: {update.message.voice is not None}, audio: {update.message.audio is not None}")

    task_text = update.message.text
    print(f"📥 Task received from user {user_id}: {task_text}")

    # Проверяем режим ожидания обратной связи
    if context.user_data.get('waiting_for_feedback'):
        feedback_text = task_text.strip()
        print(f"💬 Feedback received from user {user_id}: {feedback_text}")

        # Сохраняем обратную связь
        context.user_data['user_feedback'] = feedback_text
        context.user_data['waiting_for_feedback'] = False

        # Отправляем подтверждение и сразу переписываем
        status_msg = await update.message.reply_text("Принял, сейчас перепишем 🔄")

        # Получаем задачу и контекст
        if user_id not in user_tasks:
            await status_msg.edit_text("❌ Задача не найдена. Отправь новую задачу.")
            return

        task_name = user_tasks[user_id]['task_name']
        user_context = context.user_data.get('user_context', 'Стандартная ситуация')

        # Удаляем старые сообщения со шагами
        step_messages = context.user_data.get('step_messages', [])
        for msg_id in step_messages:
            try:
                await context.bot.delete_message(chat_id=user_id, message_id=msg_id)
            except Exception as e:
                print(f"⚠️ Could not delete message {msg_id}: {e}")

        context.user_data['step_messages'] = []

        # Редактируем статусное сообщение
        await status_msg.edit_text("⏳ Переписываю с учётом обратной связи...")

        # Регенерируем задачу с обратной связью
        await decompose_task_with_context(
            update,
            task_name,
            user_context,
            user_id,
            message=status_msg,
            skip_status_message=True,
            feedback=feedback_text,
            context_obj=context
        )
        return

    # Проверяем режим ожидания контекста
    if context.user_data.get('waiting_for_context'):
        user_context = task_text.strip()
        task_to_decompose = context.user_data.get('pending_task')

        print(f"📝 Context received from user {user_id}: {user_context}")

        # Сбрасываем флаг
        context.user_data['waiting_for_context'] = False
        context.user_data['pending_task'] = None

        # Запускаем декомпозицию с контекстом
        await decompose_task_with_context(update, task_to_decompose, user_context, user_id, context_obj=context)
        return

    # Проверяем режим редактирования одного шага
    if context.user_data.get('editing_single_step') is not None and user_id in user_tasks:
        step_num = context.user_data['editing_single_step']

        # Парсим новый текст шага
        new_step = task_text.strip()

        # Если не начинается с "Шаг", форматируем
        if not new_step.startswith('Шаг'):
            new_step = f"Шаг {step_num + 1} (5 мин): {new_step}"

        # Обновляем шаг
        user_tasks[user_id]['steps'][step_num] = new_step

        keyboard = [[InlineKeyboardButton("▶️ Продолжить", callback_data="start_steps")]]
        await update.message.reply_text(
            f"✅ Шаг обновлен:\n\n{new_step}",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

        context.user_data['editing_single_step'] = None
        return

    # Проверяем режим редактирования всего списка
    if context.user_data.get('editing_steps') and user_id in user_tasks:
        # Пользователь отправил новый список шагов
        steps = [line.strip() for line in task_text.split('\n') if line.strip().startswith('Шаг')]

        if steps:
            user_tasks[user_id]['steps'] = steps
            steps_list = '\n'.join(steps)
            keyboard = [[InlineKeyboardButton("▶️ Начать", callback_data="start_steps")]]
            await update.message.reply_text(
                f"✅ Список обновлен:\n\n{steps_list}",
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            context.user_data['editing_steps'] = False
            return
        else:
            await update.message.reply_text("Не смог распарсить шаги. Используй формат: Шаг 1 (5 мин): действие")
            return

    # Отправляем статусное сообщение
    status_msg = await update.message.reply_text("✍🏻 Хочу уточнить...")

    # Генерируем персонализированные вопросы для контекста
    print(f"🤖 Generating context questions for task: {task_text[:50]}...")

    prompt_template = load_prompt('context_questions.txt')
    if not prompt_template:
        # Fallback на стандартные вопросы
        questions_text = (
            "• Где ты сейчас находишься?\n"
            "• Сколько у тебя времени?\n"
            "• Какие ресурсы доступны?\n"
            "• Твоё текущее состояние?"
        )
    else:
        try:
            prompt = prompt_template.replace('{task}', task_text)
            response = model.generate_content(prompt)
            questions_text = response.text.strip()
            print(f"✅ Generated personalized questions")
        except Exception as e:
            print(f"⚠️ Error generating questions: {e}, using fallback")
            questions_text = (
                "• Где ты сейчас находишься?\n"
                "• Сколько у тебя времени?\n"
                "• Какие ресурсы доступны?\n"
                "• Твоё текущее состояние?"
            )

    # Запрашиваем контекст перед декомпозицией
    context.user_data['waiting_for_context'] = True
    context.user_data['pending_task'] = task_text

    keyboard = [
        [InlineKeyboardButton("⏭ Пропустить контекст", callback_data="skip_context")],
        [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
    ]
    # Редактируем статусное сообщение, заменяя его на вопросы
    await status_msg.edit_text(
        f"📋 Нужны детали:\n\n"
        f"{questions_text}\n\n"
        f"Или нажми «Пропустить контекст», тогда ответ будет менее точным.",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return

async def decompose_task_with_context(update: Update, task_text: str, user_context: str, user_id: int, message=None, skip_status_message=False, feedback=None, context_obj=None):
    """Декомпозирует задачу с учетом контекста пользователя и опциональной обратной связи"""
    # Определяем откуда отправлять сообщения - из update.message или переданный message
    msg = message if message else update.message
    if not skip_status_message:
        await msg.reply_text("⏳ Декомпозирую задачу с учетом твоего контекста...")

    # Сохраняем контекст для последующего использования
    if context_obj:
        context_obj.user_data['user_context'] = user_context

    # Загружаем промпт из файла
    prompt_template = load_prompt('decompose_task.txt')
    if not prompt_template:
        await msg.reply_text("Ошибка: не найден файл с инструкциями для AI")
        return

    # Добавляем обратную связь в промпт если есть
    prompt = prompt_template.replace('{task}', task_text).replace('{context}', user_context)
    if feedback:
        prompt += f"\n\nВАЖНО: Пользователь оставил обратную связь о предыдущих вариантах:\n{feedback}\n\nУчти эту обратную связь и создай СОВЕРШЕННО НОВЫЙ подход к решению задачи."

    try:
        print(f"🤖 Sending request to Gemini API with context...")
        response = model.generate_content(prompt)
        print(f"✅ Gemini API response received")

        steps_text = response.text
        print(f"📝 Response text: {steps_text[:200]}...")

        steps = [line.strip() for line in steps_text.split('\n') if line.strip().startswith('Шаг')]
        print(f"📋 Parsed {len(steps)} steps")

        if not steps:
            print(f"⚠️ No steps parsed from response")
            await msg.reply_text("Не смог распарсить шаги. Попробуй переформулировать задачу.")
            return

        user_tasks[user_id] = {
            'steps': steps,
            'current': 0,
            'task_name': task_text,
            'started_at': None,
            'completed': False
        }

        # Список для хранения message_id всех отправленных сообщений
        step_messages = []

        # Отправляем каждый шаг отдельным сообщением с кнопками
        for idx, step in enumerate(steps):
            keyboard = [
                [InlineKeyboardButton("🔄 Переписать", callback_data=f"rewrite_step_{idx}"),
                 InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_single_step_{idx}")]
            ]
            sent_msg = await msg.reply_text(
                step,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            step_messages.append(sent_msg.message_id)

        # После всех шагов - кнопки Начать, Переписать всё и Отменить
        final_keyboard = [
            [InlineKeyboardButton("▶️ Начать", callback_data="start_steps")],
            [InlineKeyboardButton("🔄 Переписать всё", callback_data="rewrite_all")],
            [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
        ]
        final_msg = await msg.reply_text(
            f"📋 Всего шагов: {len(steps)}",
            reply_markup=InlineKeyboardMarkup(final_keyboard)
        )
        step_messages.append(final_msg.message_id)

        # Сохраняем message_id в context для последующего удаления
        if context_obj:
            context_obj.user_data['step_messages'] = step_messages

        print(f"✅ Steps sent to user {user_id}")

    except Exception as e:
        print(f"❌ ERROR in decompose_task_with_context: {type(e).__name__}: {str(e)}")
        traceback.print_exc()
        await msg.reply_text(f"Произошла ошибка: {type(e).__name__}: {str(e)}")

async def edit_steps(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена. Отправь новую.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    steps = user_tasks[user_id]['steps']
    steps_list = '\n'.join(steps)

    keyboard = [
        [InlineKeyboardButton("✅ Сохранить и начать", callback_data="start_steps")],
        [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
    ]

    await query.edit_message_text(
        f"Текущий список шагов:\n\n{steps_list}\n\n"
        "Отправь новый список в формате:\n"
        "Шаг 1 (5 мин): действие\n"
        "Шаг 2 (7 мин): действие\n\n"
        "Или нажми 'Сохранить и начать'",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

    context.user_data['editing_steps'] = True

async def skip_context(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик кнопки Пропустить контекст"""
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    task_text = context.user_data.get('pending_task')
    if not task_text:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    print(f"⏭ User {user_id} skipped context")

    # Сбрасываем флаги
    context.user_data['waiting_for_context'] = False
    context.user_data['pending_task'] = None

    # Декомпозируем без контекста (используем дефолтный контекст)
    await query.edit_message_text("⏳ Декомпозирую задачу...")
    await decompose_task_with_context(update, task_text, "Стандартная ситуация", user_id, message=query.message, skip_status_message=True, context_obj=context)

async def start_steps(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    print(f"▶️ User {user_id} started steps")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена. Отправь новую.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    user_tasks[user_id]['started_at'] = datetime.now()
    context.user_data['editing_steps'] = False

    await send_current_step(query, user_id, context)

async def send_current_step(query, user_id, context):
    task_data = user_tasks[user_id]
    current = task_data['current']
    steps = task_data['steps']

    if current >= len(steps):
        print(f"🎉 User {user_id} completed all steps")

        # Сохраняем в историю
        if user_id not in user_history:
            user_history[user_id] = []

        task_data['completed'] = True
        task_data['completed_at'] = datetime.now()
        user_history[user_id].append(task_data.copy())

        keyboard = [
            [InlineKeyboardButton("➕ Новая задача", callback_data="new_task")]
        ]

        await query.edit_message_text(
            "🎉 Все шаги выполнены! Задача завершена.",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

        del user_tasks[user_id]
        return

    step = steps[current]
    minutes = 5

    if 'мин' in step:
        try:
            minutes = int(step.split('(')[1].split('мин')[0].strip())
        except:
            pass

    print(f"📤 Sending step {current + 1}/{len(steps)} to user {user_id}, timer: {minutes} min")

    # Кнопки для управления шагом
    keyboard = [
        [InlineKeyboardButton("✅ Готово", callback_data="next_step"),
         InlineKeyboardButton("⏭ Пропустить", callback_data="skip_step")],
        [InlineKeyboardButton("◀️ Назад", callback_data="prev_step"),
         InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
    ]

    # Запускаем таймер в реальном времени
    end_time = datetime.now() + timedelta(minutes=minutes)
    task_data['current_step_end_time'] = end_time

    await query.edit_message_text(
        f"Шаг {current + 1}/{len(steps)}:\n\n{step}\n\n⏱ Осталось: {minutes:02d}:00",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

    # Создаем задачу обновления таймера
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    timer_tasks[user_id] = asyncio.create_task(
        update_timer(query, user_id, minutes, current, context)
    )

async def update_timer(query, user_id, total_minutes, step_num, context):
    # Обновляет таймер в реальном времени каждую секунду, используя реальное время
    try:
        if user_id not in user_tasks:
            return

        task_data = user_tasks[user_id]
        end_time = task_data.get('current_step_end_time')

        if not end_time:
            return

        while True:
            await asyncio.sleep(1)

            if user_id not in user_tasks or user_tasks[user_id]['current'] != step_num:
                return

            # Вычисляем реальное оставшееся время
            now = datetime.now()
            remaining_time = end_time - now

            if remaining_time.total_seconds() <= 0:
                # Время вышло
                task_data = user_tasks[user_id]
                steps = task_data['steps']

                keyboard = [
                    [InlineKeyboardButton("✅ Готово", callback_data="next_step"),
                     InlineKeyboardButton("⏭ Пропустить", callback_data="skip_step")],
                    [InlineKeyboardButton("◀️ Назад", callback_data="prev_step"),
                     InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
                ]
                await query.message.reply_text(
                    "⏰ Время вышло! Готово?",
                    reply_markup=InlineKeyboardMarkup(keyboard)
                )
                return

            task_data = user_tasks[user_id]
            steps = task_data['steps']
            step = steps[step_num]

            remaining_seconds = int(remaining_time.total_seconds())
            mins = remaining_seconds // 60
            secs = remaining_seconds % 60

            keyboard = [
                [InlineKeyboardButton("✅ Готово", callback_data="next_step"),
                 InlineKeyboardButton("⏭ Пропустить", callback_data="skip_step")],
                [InlineKeyboardButton("◀️ Назад", callback_data="prev_step"),
                 InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
            ]

            try:
                await query.message.edit_text(
                    f"Шаг {step_num + 1}/{len(steps)}:\n\n{step}\n\n"
                    f"⏱ Осталось: {mins:02d}:{secs:02d}",
                    reply_markup=InlineKeyboardMarkup(keyboard)
                )
            except Exception as e:
                # Игнорируем ошибки "message is not modified"
                if "message is not modified" not in str(e).lower():
                    print(f"⚠️ Could not update timer: {e}")

    except asyncio.CancelledError:
        print(f"⏱ Timer cancelled for user {user_id}")
    except Exception as e:
        print(f"❌ Error in timer: {e}")

async def next_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    print(f"➡️ User {user_id} clicked next step")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    # Отменяем таймер текущего шага
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    user_tasks[user_id]['current'] += 1
    await send_current_step(query, user_id, context)

async def skip_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer("⏭ Шаг пропущен")
    user_id = update.effective_user.id

    print(f"⏭ User {user_id} skipped step")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    # Отменяем таймер текущего шага
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    user_tasks[user_id]['current'] += 1
    await send_current_step(query, user_id, context)

async def prev_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = update.effective_user.id

    if user_id not in user_tasks:
        await query.answer()
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    task_data = user_tasks[user_id]
    current = task_data['current']

    # Если это первый шаг, возвращаемся к просмотру всех шагов
    if current <= 0:
        await query.answer("◀️ Возврат к просмотру шагов")
        print(f"◀️ User {user_id} returned to steps overview from first step")

        # Отменяем таймер
        if user_id in timer_tasks:
            timer_tasks[user_id].cancel()

        # Сбрасываем прогресс
        user_tasks[user_id]['current'] = 0
        user_tasks[user_id]['started_at'] = None

        # Удаляем текущее сообщение
        try:
            await query.message.delete()
        except Exception as e:
            print(f"⚠️ Could not delete message: {e}")

        # Показываем все шаги заново
        steps = task_data['steps']
        step_messages = []

        for idx, step in enumerate(steps):
            keyboard = [
                [InlineKeyboardButton("🔄 Переписать", callback_data=f"rewrite_step_{idx}"),
                 InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_single_step_{idx}")]
            ]
            sent_msg = await context.bot.send_message(
                chat_id=user_id,
                text=step,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            step_messages.append(sent_msg.message_id)

        # Финальное сообщение с кнопками
        final_keyboard = [
            [InlineKeyboardButton("▶️ Начать", callback_data="start_steps")],
            [InlineKeyboardButton("🔄 Переписать всё", callback_data="rewrite_all")],
            [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
        ]
        final_msg = await context.bot.send_message(
            chat_id=user_id,
            text=f"📋 Всего шагов: {len(steps)}",
            reply_markup=InlineKeyboardMarkup(final_keyboard)
        )
        step_messages.append(final_msg.message_id)

        # Сохраняем message_id в context
        context.user_data['step_messages'] = step_messages
        return

    await query.answer("◀️ Возврат к предыдущему шагу")
    print(f"◀️ User {user_id} went back to previous step")

    # Отменяем таймер текущего шага
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    user_tasks[user_id]['current'] -= 1
    await send_current_step(query, user_id, context)

async def cancel_task(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    print(f"❌ User {user_id} cancelled task")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    # Отменяем таймер
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()
        del timer_tasks[user_id]

    task_name = user_tasks[user_id]['task_name']
    del user_tasks[user_id]

    keyboard = [[InlineKeyboardButton("➕ Новая задача", callback_data="new_task")]]

    await query.edit_message_text(
        f"❌ Задача отменена: {task_name}\n\nМожешь начать новую задачу.",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def rewrite_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик кнопки 'Переписать всё' - полностью регенерирует задачи"""
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    print(f"🔄 User {user_id} requested full rewrite")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    # Получаем счётчик нажатий
    rewrite_count = context.user_data.get('rewrite_all_count', 0)

    print(f"📊 Rewrite count: {rewrite_count}/2")

    # Если достигнут лимит - запрашиваем обратную связь
    if rewrite_count >= 2:
        print(f"⚠️ Rewrite limit reached, requesting feedback")

        # Удаляем все сообщения со шагами
        step_messages = context.user_data.get('step_messages', [])
        for msg_id in step_messages:
            try:
                await context.bot.delete_message(chat_id=user_id, message_id=msg_id)
            except Exception as e:
                print(f"⚠️ Could not delete message {msg_id}: {e}")

        # Сбрасываем счётчик
        context.user_data['rewrite_all_count'] = 0
        context.user_data['step_messages'] = []

        # Удаляем финальное сообщение с кнопками
        try:
            await query.message.delete()
        except Exception as e:
            print(f"⚠️ Could not delete final message: {e}")

        # Спрашиваем обратную связь
        context.user_data['waiting_for_feedback'] = True
        await context.bot.send_message(
            chat_id=user_id,
            text="🤔 Расскажи, чего не хватает? Что нужно улучшить в выдаче?\n\n"
                 "Твоя обратная связь поможет мне понять твои ожидания и сделать ответы лучше"
        )
        return

    # Увеличиваем счётчик
    context.user_data['rewrite_all_count'] = rewrite_count + 1
    print(f"📈 Rewrite count increased to {rewrite_count + 1}")

    # Получаем оригинальную задачу и контекст
    task_text = user_tasks[user_id]['task_name']
    user_context = context.user_data.get('user_context', 'Стандартная ситуация')

    # Получаем обратную связь если есть
    feedback = context.user_data.get('user_feedback', None)

    # Сначала редактируем финальное сообщение (до удаления шагов)
    await query.edit_message_text("⏳ Полностью переписываю задачу с новым подходом...")

    # Удаляем старые сообщения со шагами
    step_messages = context.user_data.get('step_messages', [])
    for msg_id in step_messages:
        try:
            await context.bot.delete_message(chat_id=user_id, message_id=msg_id)
        except Exception as e:
            print(f"⚠️ Could not delete message {msg_id}: {e}")

    context.user_data['step_messages'] = []

    # Регенерируем задачу с обратной связью
    await decompose_task_with_context(
        update,
        task_text,
        user_context,
        user_id,
        message=query.message,
        skip_status_message=True,
        feedback=feedback,
        context_obj=context
    )

async def rewrite_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    # Извлекаем номер шага из callback_data
    step_num = int(query.data.split('_')[-1])

    print(f"🔄 User {user_id} requested rewrite for step {step_num}")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    task_data = user_tasks[user_id]
    steps = task_data['steps']

    if step_num >= len(steps):
        await query.edit_message_text("Шаг не найден.")
        return

    current_step = steps[step_num]

    # Отменяем таймер
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    await query.edit_message_text("⏳ Переписываю шаг...")

    try:
        # Загружаем промпт из файла
        prompt_template = load_prompt('rewrite_step.txt')
        if not prompt_template:
            await query.edit_message_text("Ошибка: не найден файл с инструкциями для AI")
            return

        prompt = prompt_template.replace('{step}', current_step).replace('{step_number}', str(step_num + 1))

        response = model.generate_content(prompt)
        new_step = response.text.strip()

        # Проверяем, что ответ начинается с "Шаг"
        if not new_step.startswith('Шаг'):
            new_step = f"Шаг {step_num + 1} (5 мин): {new_step}"

        # Обновляем шаг
        user_tasks[user_id]['steps'][step_num] = new_step

        print(f"✅ Step rewritten for user {user_id}")

        # Обновляем сообщение с новым текстом шага и теми же кнопками
        keyboard = [
            [InlineKeyboardButton("🔄 Переписать", callback_data=f"rewrite_step_{step_num}"),
             InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_single_step_{step_num}")],
            [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
        ]
        await query.edit_message_text(new_step, reply_markup=InlineKeyboardMarkup(keyboard))

    except Exception as e:
        print(f"❌ Error in rewrite_step: {e}")
        await query.edit_message_text(f"Произошла ошибка при переписывании: {str(e)}")

async def edit_single_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    # Извлекаем номер шага из callback_data
    step_num = int(query.data.split('_')[-1])

    print(f"✏️ User {user_id} requested edit for step {step_num}")

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    task_data = user_tasks[user_id]
    steps = task_data['steps']

    if step_num >= len(steps):
        await query.edit_message_text("Шаг не найден.")
        return

    current_step = steps[step_num]

    # Отменяем таймер
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    # Сохраняем информацию о том, что редактируется конкретный шаг
    context.user_data['editing_single_step'] = step_num

    keyboard = [[InlineKeyboardButton("❌ Отмена", callback_data="cancel_edit_step")]]

    await query.edit_message_text(
        f"Текущий шаг:\n\n{current_step}\n\n"
        "Отправь новый текст шага в формате:\n"
        "Шаг X (Y мин): действие\n\n"
        "Или нажми 'Отмена' для возврата",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def cancel_edit_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    print(f"❌ User {user_id} cancelled step edit")

    step_num = context.user_data.get('editing_single_step')
    context.user_data['editing_single_step'] = None

    if user_id not in user_tasks:
        keyboard = [[InlineKeyboardButton("📝 Описать задачу", callback_data="new_task")]]
        await query.edit_message_text("Задача не найдена.", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    if step_num is None:
        await query.edit_message_text("Ошибка: не найден номер шага.")
        return

    # Возвращаем исходный текст шага с кнопками
    step_text = user_tasks[user_id]['steps'][step_num]
    keyboard = [
        [InlineKeyboardButton("🔄 Переписать", callback_data=f"rewrite_step_{step_num}"),
         InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_single_step_{step_num}")],
        [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
    ]
    await query.edit_message_text(step_text, reply_markup=InlineKeyboardMarkup(keyboard))

async def show_history(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    if user_id not in user_history or not user_history[user_id]:
        await query.edit_message_text(
            "📊 История пуста. Начни первую задачу!",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("➕ Новая задача", callback_data="new_task")]])
        )
        return

    history = user_history[user_id]
    history_text = "📊 История выполненных задач:\n\n"

    for i, task in enumerate(history[-5:], 1):
        task_name = task['task_name']
        steps_count = len(task['steps'])
        completed_at = task.get('completed_at', 'неизвестно')

        if isinstance(completed_at, datetime):
            completed_at = completed_at.strftime('%d.%m.%Y %H:%M')

        history_text += f"{i}. {task_name}\n   Шагов: {steps_count} | {completed_at}\n\n"

    keyboard = [[InlineKeyboardButton("➕ Новая задача", callback_data="new_task")]]

    await query.edit_message_text(history_text, reply_markup=InlineKeyboardMarkup(keyboard))

async def new_task(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    await query.edit_message_text(
        "Отправь мне новую задачу, я разобью её на абсурдно простые шаги по 5-10 минут."
    )

async def history_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id

    if user_id not in user_history or not user_history[user_id]:
        keyboard = [[InlineKeyboardButton("➕ Начать задачу", callback_data="new_task")]]
        await update.message.reply_text(
            "📊 История пуста. Начни первую задачу!",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
        return

    history = user_history[user_id]
    history_text = "📊 История выполненных задач:\n\n"

    for i, task in enumerate(history[-10:], 1):
        task_name = task['task_name']
        steps_count = len(task['steps'])
        completed_at = task.get('completed_at', 'неизвестно')

        if isinstance(completed_at, datetime):
            completed_at = completed_at.strftime('%d.%m.%Y %H:%M')

        history_text += f"{i}. {task_name}\n   Шагов: {steps_count} | {completed_at}\n\n"

    keyboard = [[InlineKeyboardButton("➕ Новая задача", callback_data="new_task")]]

    await update.message.reply_text(history_text, reply_markup=InlineKeyboardMarkup(keyboard))

async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обрабатывает голосовые сообщения и транскрибирует их"""
    user_id = update.effective_user.id
    print(f"🎤 Voice message received from user {user_id}")

    if not ASSEMBLYAI_API_KEY:
        await update.message.reply_text("⚠️ Функция распознавания голоса временно недоступна. API ключ не настроен.")
        return

    # Отправляем статус "печатает"
    status_msg = await update.message.reply_text("🎤 Расшифровываю голосовое сообщение...")

    try:
        # Получаем файл голосового сообщения
        voice = update.message.voice
        file = await context.bot.get_file(voice.file_id)

        # Сохраняем временно на диск
        voice_path = f"temp_voice_{user_id}_{voice.file_id}.oga"
        await file.download_to_drive(voice_path)

        print(f"📥 Voice file downloaded: {voice_path}")

        # Транскрибируем с помощью AssemblyAI
        transcriber = aai.Transcriber()
        config = aai.TranscriptionConfig(language_code="ru")  # Русский язык

        print(f"🔄 Starting transcription...")
        transcript = transcriber.transcribe(voice_path, config=config)

        # Удаляем временный файл
        if os.path.exists(voice_path):
            os.remove(voice_path)

        if transcript.status == aai.TranscriptStatus.error:
            print(f"❌ Transcription error: {transcript.error}")
            await status_msg.edit_text(f"❌ Ошибка при расшифровке: {transcript.error}")
            return

        transcribed_text = transcript.text
        print(f"✅ Transcription successful: {transcribed_text[:100]}...")

        # Обновляем сообщение с расшифровкой
        await status_msg.edit_text(
            f"✅ Расшифровка голосового сообщения:\n\n\"{transcribed_text}\"\n\n"
            f"Собираюсь уточнить..."
        )

        # Запускаем обработку расшифрованного текста
        # handle_task_from_text сама определит, это новая задача или контекст
        # Передаём status_msg для редактирования
        await handle_task_from_text(update, context, transcribed_text, status_msg)

    except Exception as e:
        print(f"❌ Error in handle_voice: {type(e).__name__}: {str(e)}")
        traceback.print_exc()
        await status_msg.edit_text(f"❌ Произошла ошибка при обработке голосового сообщения: {str(e)}")

        # Удаляем временный файл если он существует
        try:
            if os.path.exists(voice_path):
                os.remove(voice_path)
        except:
            pass

async def handle_task_from_text(update: Update, context: ContextTypes.DEFAULT_TYPE, task_text: str, status_msg=None):
    """Вспомогательная функция для обработки задачи из текста (используется после расшифровки голоса)"""
    user_id = update.effective_user.id

    # Проверяем, не ожидается ли уже контекст (если пользователь отправил голосовое как контекст)
    if context.user_data.get('waiting_for_context'):
        user_context = task_text.strip()
        task_to_decompose = context.user_data.get('pending_task')

        print(f"📝 Context received from user {user_id} (voice): {user_context}")

        # Сбрасываем флаг
        context.user_data['waiting_for_context'] = False
        context.user_data['pending_task'] = None

        # Запускаем декомпозицию с контекстом
        await decompose_task_with_context(update, task_to_decompose, user_context, user_id, context_obj=context)
        return

    # Генерируем персонализированные вопросы для контекста
    print(f"🤖 Generating context questions for task: {task_text[:50]}...")

    prompt_template = load_prompt('context_questions.txt')
    if not prompt_template:
        # Fallback на стандартные вопросы
        questions_text = (
            "• Где ты сейчас находишься?\n"
            "• Сколько у тебя времени?\n"
            "• Какие ресурсы доступны?\n"
            "• Твоё текущее состояние?"
        )
    else:
        try:
            prompt = prompt_template.replace('{task}', task_text)
            response = model.generate_content(prompt)
            questions_text = response.text.strip()
            print(f"✅ Generated personalized questions")
        except Exception as e:
            print(f"⚠️ Error generating questions: {e}, using fallback")
            questions_text = (
                "• Где ты сейчас находишься?\n"
                "• Сколько у тебя времени?\n"
                "• Какие ресурсы доступны?\n"
                "• Твоё текущее состояние?"
            )

    # Запрашиваем контекст перед декомпозицией
    context.user_data['waiting_for_context'] = True
    context.user_data['pending_task'] = task_text

    keyboard = [
        [InlineKeyboardButton("⏭ Пропустить контекст", callback_data="skip_context")],
        [InlineKeyboardButton("❌ Отменить", callback_data="cancel_task")]
    ]

    # Если передано status_msg (из голосовых), редактируем его, иначе создаём новое
    if status_msg:
        await status_msg.edit_text(
            f"📋 Расскажи немного о своей ситуации для более персонализированной декомпозиции:\n\n"
            f"{questions_text}\n\n"
            f"Или нажми 'Пропустить контекст' для стандартной декомпозиции.",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    else:
        await update.message.reply_text(
            f"📋 Расскажи немного о своей ситуации для более персонализированной декомпозиции:\n\n"
            f"{questions_text}\n\n"
            f"Или нажми 'Пропустить контекст' для стандартной декомпозиции.",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

# Debug handler для отладки всех входящих сообщений
async def debug_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Логирует все входящие сообщения для отладки"""
    msg = update.message
    user_id = update.effective_user.id

    print(f"\n🔍 DEBUG: Message received from user {user_id}")
    print(f"🔍 Has text: {msg.text is not None}")
    print(f"🔍 Has voice: {msg.voice is not None}")
    print(f"🔍 Has audio: {msg.audio is not None}")
    print(f"🔍 Has document: {msg.document is not None}")
    print(f"🔍 Has photo: {msg.photo is not None if msg.photo else False}")
    print(f"🔍 Content type: {msg.content_type if hasattr(msg, 'content_type') else 'unknown'}")

    if msg.text:
        print(f"🔍 Text content: {msg.text[:50]}")
    if msg.voice:
        print(f"🔍 Voice file_id: {msg.voice.file_id}")
        print(f"🔍 Voice duration: {msg.voice.duration}s")
    print()

# Настройка приложения Telegram
async def setup_application():
    global application
    print("🔧 Setting up Telegram application...")
    application = Application.builder().token(TELEGRAM_TOKEN).build()

    # DEBUG: универсальный handler для логирования всех сообщений (группа -1 = выполняется первым)
    application.add_handler(MessageHandler(filters.ALL, debug_handler), group=-1)

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("history", history_command))
    application.add_handler(MessageHandler(filters.VOICE, handle_voice))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_task))
    application.add_handler(CallbackQueryHandler(skip_context, pattern="^skip_context$"))
    application.add_handler(CallbackQueryHandler(start_steps, pattern="^start_steps$"))
    application.add_handler(CallbackQueryHandler(edit_steps, pattern="^edit_steps$"))
    application.add_handler(CallbackQueryHandler(next_step, pattern="^next_step$"))
    application.add_handler(CallbackQueryHandler(skip_step, pattern="^skip_step$"))
    application.add_handler(CallbackQueryHandler(prev_step, pattern="^prev_step$"))
    application.add_handler(CallbackQueryHandler(cancel_task, pattern="^cancel_task$"))
    application.add_handler(CallbackQueryHandler(rewrite_all, pattern="^rewrite_all$"))
    application.add_handler(CallbackQueryHandler(rewrite_step, pattern="^rewrite_step_"))
    application.add_handler(CallbackQueryHandler(edit_single_step, pattern="^edit_single_step_"))
    application.add_handler(CallbackQueryHandler(cancel_edit_step, pattern="^cancel_edit_step$"))
    application.add_handler(CallbackQueryHandler(show_history, pattern="^show_history$"))
    application.add_handler(CallbackQueryHandler(new_task, pattern="^new_task$"))

    await application.initialize()
    await application.start()
    print("✅ Telegram application initialized")

async def setup_webhook():
    try:
        print("🔧 Setting up webhook...")
        bot = Bot(token=TELEGRAM_TOKEN)
        await bot.initialize()
        result = await bot.set_webhook(url=WEBHOOK_URL)
        await bot.shutdown()
        print(f"✅ Webhook set: {WEBHOOK_URL} -> {result}")
    except Exception as e:
        print(f"❌ Error setting webhook: {e}")
        traceback.print_exc()

async def process_updates():
    global application, update_queue
    print("🚀 Starting update processor...")
    while True:
        try:
            try:
                update_data = update_queue.get(timeout=1)
            except queue.Empty:
                continue

            if update_data is None:
                break

            update = Update.de_json(update_data, application.bot)
            await application.process_update(update)
            print(f"✅ Processed update: {update.update_id}")
        except Exception as e:
            print(f"❌ Error processing update: {e}")
            traceback.print_exc()

        await asyncio.sleep(0.01)

def run_bot_polling():
    """Запуск бота в режиме polling (для локального тестирования)"""
    try:
        print("🔄 Starting polling mode...")
        application_builder = Application.builder().token(TELEGRAM_TOKEN)
        application_instance = application_builder.build()

        # DEBUG: универсальный handler для логирования всех сообщений (группа -1 = выполняется первым)
        application_instance.add_handler(MessageHandler(filters.ALL, debug_handler), group=-1)

        application_instance.add_handler(CommandHandler("start", start))
        application_instance.add_handler(CommandHandler("history", history_command))
        application_instance.add_handler(MessageHandler(filters.VOICE, handle_voice))
        application_instance.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_task))
        application_instance.add_handler(CallbackQueryHandler(skip_context, pattern="^skip_context$"))
        application_instance.add_handler(CallbackQueryHandler(start_steps, pattern="^start_steps$"))
        application_instance.add_handler(CallbackQueryHandler(edit_steps, pattern="^edit_steps$"))
        application_instance.add_handler(CallbackQueryHandler(next_step, pattern="^next_step$"))
        application_instance.add_handler(CallbackQueryHandler(skip_step, pattern="^skip_step$"))
        application_instance.add_handler(CallbackQueryHandler(prev_step, pattern="^prev_step$"))
        application_instance.add_handler(CallbackQueryHandler(cancel_task, pattern="^cancel_task$"))
        application_instance.add_handler(CallbackQueryHandler(rewrite_all, pattern="^rewrite_all$"))
        application_instance.add_handler(CallbackQueryHandler(rewrite_step, pattern="^rewrite_step_"))
        application_instance.add_handler(CallbackQueryHandler(edit_single_step, pattern="^edit_single_step_"))
        application_instance.add_handler(CallbackQueryHandler(cancel_edit_step, pattern="^cancel_edit_step$"))
        application_instance.add_handler(CallbackQueryHandler(show_history, pattern="^show_history$"))
        application_instance.add_handler(CallbackQueryHandler(new_task, pattern="^new_task$"))

        print("✅ Bot handlers registered")
        print("🚀 Bot is running in polling mode...")

        # Запуск polling
        application_instance.run_polling(allowed_updates=Update.ALL_TYPES)
    except Exception as e:
        print(f"❌ Error in bot: {e}")
        traceback.print_exc()

def run_bot_webhook():
    """Запуск бота в режиме webhook (для продакшена)"""
    global bot_loop
    try:
        bot_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(bot_loop)
        bot_loop.run_until_complete(setup_application())
        bot_loop.run_until_complete(setup_webhook())
        bot_loop.run_until_complete(process_updates())
    except Exception as e:
        print(f"❌ Error in bot thread: {e}")
        traceback.print_exc()
    finally:
        if bot_loop:
            bot_loop.close()

# Flask routes
@app.route('/')
def index():
    return "✅ Бот работает!"

@app.route('/webhook', methods=['POST'])
def webhook():
    try:
        json_data = request.get_json()
        if not json_data:
            return "No data", 400

        update_queue.put(json_data)
        print(f"📨 Update queued: {json_data.get('update_id', 'unknown')}")
        return "OK", 200
    except Exception as e:
        print(f"❌ Error in webhook: {e}")
        traceback.print_exc()
        return "Error", 500

@app.route('/health')
def health():
    return "OK", 200

if __name__ == '__main__':
    # Определяем режим работы: если RENDER_EXTERNAL_URL пустой - локальный режим (polling)
    is_local = not WEBHOOK_URL or WEBHOOK_URL == "/webhook"

    if is_local:
        print("🚀 Starting bot in LOCAL mode (polling)...")
        run_bot_polling()
    else:
        print("🚀 Starting bot in PRODUCTION mode (webhook)...")
        # Запускаем бота в отдельном потоке
        bot_thread = threading.Thread(target=run_bot_webhook, daemon=True)
        bot_thread.start()

        import time
        time.sleep(3)

        # Запуск Flask
        port = int(os.environ.get('PORT', 10000))
        print(f"🌐 Starting Flask server on port {port}")
        app.run(host='0.0.0.0', port=port, debug=False, threaded=True, use_reloader=False)
