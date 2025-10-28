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

# Токены
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GEMINI_KEY = os.getenv("GEMINI_KEY")
WEBHOOK_URL = os.getenv("RENDER_EXTERNAL_URL", "https://rozysk-avto-bot.onrender.com") + "/webhook"

# Диагностика ключей
print(f"🔍 TELEGRAM_TOKEN: {'OK' if TELEGRAM_TOKEN else 'MISSING'}")
print(f"🔍 GEMINI_KEY: {'OK (' + str(len(GEMINI_KEY)) + ' chars)' if GEMINI_KEY else 'MISSING'}")
print(f"🔍 WEBHOOK_URL: {WEBHOOK_URL}")

# Настройка Gemini
genai.configure(api_key=GEMINI_KEY)
model = genai.GenerativeModel('gemini-2.5-flash')

app = Flask(__name__)

# Хранилище задач с историей
user_tasks = {}
user_history = {}
update_queue = queue.Queue()
application = None
bot_loop = None
timer_tasks = {}

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    print(f"📥 /start command from user {update.effective_user.id}")
    await update.message.reply_text(
        "Отправь мне задачу, я разобью её на абсурдно простые шаги по 5-10 минут.\n\n"
        "Например: 'написать статью про AI' или 'разобрать почту'\n\n"
        "📊 /history - посмотреть историю задач"
    )

async def handle_task(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    task_text = update.message.text
    print(f"📥 Task received from user {user_id}: {task_text}")

    # Проверяем режим редактирования
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

    await update.message.reply_text("⏳ Декомпозирую задачу...")

    prompt = f"""Декомпозируй задачу на шаги. Каждый шаг - АБСУРДНО простое действие на 5-10 минут.
Примеры шагов: "открой ноутбук", "создай пустой файл", "напиши заголовок".

Задача: {task_text}

Формат ответа (строго):
Шаг 1 (5 мин): действие
Шаг 2 (7 мин): действие
...

Максимум 8 шагов."""

    try:
        print(f"🤖 Sending request to Gemini API...")
        response = model.generate_content(prompt)
        print(f"✅ Gemini API response received")

        steps_text = response.text
        print(f"📝 Response text: {steps_text[:200]}...")

        steps = [line.strip() for line in steps_text.split('\n') if line.strip().startswith('Шаг')]
        print(f"📋 Parsed {len(steps)} steps")

        if not steps:
            print(f"⚠️ No steps parsed from response")
            await update.message.reply_text("Не смог распарсить шаги. Попробуй переформулировать задачу.")
            return

        user_tasks[user_id] = {
            'steps': steps, 
            'current': 0, 
            'task_name': task_text,
            'started_at': None,
            'completed': False
        }

        steps_list = '\n'.join(steps)
        keyboard = [
            [InlineKeyboardButton("▶️ Начать", callback_data="start_steps")],
            [InlineKeyboardButton("✏️ Редактировать список", callback_data="edit_steps")]
        ]

        await update.message.reply_text(
            f"📋 Задача: {task_text}\n\n{steps_list}",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

        print(f"✅ Steps sent to user {user_id}")

    except Exception as e:
        print(f"❌ ERROR in handle_task: {type(e).__name__}: {str(e)}")
        traceback.print_exc()
        await update.message.reply_text(f"Произошла ошибка: {type(e).__name__}: {str(e)}")

async def edit_steps(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    if user_id not in user_tasks:
        await query.edit_message_text("Задача не найдена. Отправь новую.")
        return

    steps = user_tasks[user_id]['steps']
    steps_list = '\n'.join(steps)

    keyboard = [[InlineKeyboardButton("✅ Сохранить и начать", callback_data="start_steps")]]

    await query.edit_message_text(
        f"Текущий список шагов:\n\n{steps_list}\n\n"
        "Отправь новый список в формате:\n"
        "Шаг 1 (5 мин): действие\n"
        "Шаг 2 (7 мин): действие\n\n"
        "Или нажми 'Сохранить и начать'",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

    context.user_data['editing_steps'] = True

async def start_steps(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id

    print(f"▶️ User {user_id} started steps")

    if user_id not in user_tasks:
        await query.edit_message_text("Задача не найдена. Отправь новую.")
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
            [InlineKeyboardButton("📊 История задач", callback_data="show_history")],
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

    keyboard = [[InlineKeyboardButton("✅ Готово", callback_data="next_step")]]

    # Запускаем таймер в реальном времени
    end_time = datetime.now() + timedelta(minutes=minutes)
    task_data['current_step_end_time'] = end_time

    await query.edit_message_text(
        f"Шаг {current + 1}/{len(steps)}:\n\n{step}\n\n⏱ Таймер: {minutes} мин",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

    # Создаем задачу обновления таймера
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    timer_tasks[user_id] = asyncio.create_task(
        update_timer(query, user_id, minutes, current, context)
    )

async def update_timer(query, user_id, total_minutes, step_num, context):
    # Обновляет таймер в реальном времени каждую минуту
    try:
        for remaining in range(total_minutes - 1, -1, -1):
            await asyncio.sleep(60)

            if user_id not in user_tasks or user_tasks[user_id]['current'] != step_num:
                return

            task_data = user_tasks[user_id]
            steps = task_data['steps']
            step = steps[step_num]

            keyboard = [[InlineKeyboardButton("✅ Готово", callback_data="next_step")]]

            try:
                await query.message.edit_text(
                    f"Шаг {step_num + 1}/{len(steps)}:\n\n{step}\n\n"
                    f"⏱ Осталось: {remaining} мин",
                    reply_markup=InlineKeyboardMarkup(keyboard)
                )
            except Exception as e:
                print(f"⚠️ Could not update timer: {e}")

        # Время вышло
        if user_id in user_tasks and user_tasks[user_id]['current'] == step_num:
            keyboard = [[InlineKeyboardButton("✅ Готово", callback_data="next_step")]]
            await query.message.reply_text(
                "⏰ Время вышло! Готово?",
                reply_markup=InlineKeyboardMarkup(keyboard)
            )

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
        await query.edit_message_text("Задача не найдена.")
        return

    # Отменяем таймер текущего шага
    if user_id in timer_tasks:
        timer_tasks[user_id].cancel()

    user_tasks[user_id]['current'] += 1
    await send_current_step(query, user_id, context)

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

# Настройка приложения Telegram
async def setup_application():
    global application
    print("🔧 Setting up Telegram application...")
    application = Application.builder().token(TELEGRAM_TOKEN).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("history", history_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_task))
    application.add_handler(CallbackQueryHandler(start_steps, pattern="^start_steps$"))
    application.add_handler(CallbackQueryHandler(edit_steps, pattern="^edit_steps$"))
    application.add_handler(CallbackQueryHandler(next_step, pattern="^next_step$"))
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

def run_bot():
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
    print("🚀 Starting bot with webhook...")

    # Запускаем бота в отдельном потоке
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()

    import time
    time.sleep(3)

    # Запуск Flask
    port = int(os.environ.get('PORT', 10000))
    print(f"🌐 Starting Flask server on port {port}")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True, use_reloader=False)
