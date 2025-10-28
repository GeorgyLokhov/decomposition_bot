import os
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, ContextTypes, filters
import anthropic
import asyncio

# Токены
TELEGRAM_TOKEN = "ВСТАВЬ_ТОКЕН_БОТА"
ANTHROPIC_KEY = "ВСТАВЬ_КЛЮЧ_CLAUDE"

client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

# Хранилище задач пользователей
user_tasks = {}

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Отправь мне задачу, я разобью её на абсурдно простые шаги по 5-10 минут.\n\n"
        "Например: 'написать статью про AI' или 'разобрать почту'"
    )

async def handle_task(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    task_text = update.message.text
    
    await update.message.reply_text("⏳ Декомпозирую задачу...")
    
    # Запрос к Claude
    prompt = f"""Декомпозируй задачу на шаги. Каждый шаг - АБСУРДНО простое действие на 5-10 минут.
Примеры шагов: "открой ноутбук", "создай пустой файл", "напиши заголовок".

Задача: {task_text}

Формат ответа (строго):
Шаг 1 (5 мин): действие
Шаг 2 (7 мин): действие
...

Максимум 8 шагов."""

    message = client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}]
    )
    
    steps_text = message.content[0].text
    
    # Парсинг шагов
    steps = []
    for line in steps_text.split('\n'):
        if line.strip().startswith('Шаг'):
            steps.append(line.strip())
    
    if not steps:
        await update.message.reply_text("Не смог распарсить шаги. Попробуй переформулировать задачу.")
        return
    
    # Сохраняем
    user_tasks[user_id] = {
        'steps': steps,
        'current': 0,
        'task_name': task_text
    }
    
    # Показываем шаги
    steps_list = '\n'.join(steps)
    keyboard = [[InlineKeyboardButton("▶️ Начать", callback_data="start_steps")]]
    
    await update.message.reply_text(
        f"📋 Задача: {task_text}\n\n{steps_list}",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def start_steps(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    
    if user_id not in user_tasks:
        await query.edit_message_text("Задача не найдена. Отправь новую.")
        return
    
    await send_current_step(query, user_id, context)

async def send_current_step(query, user_id, context):
    task_data = user_tasks[user_id]
    current = task_data['current']
    steps = task_data['steps']
    
    if current >= len(steps):
        await query.edit_message_text("🎉 Все шаги выполнены! Задача завершена.")
        del user_tasks[user_id]
        return
    
    step = steps[current]
    
    # Извлекаем время
    minutes = 5  # по умолчанию
    if 'мин' in step:
        try:
            minutes = int(step.split('(')[1].split('мин')[0].strip())
        except:
            pass
    
    keyboard = [[InlineKeyboardButton("✅ Готово", callback_data="next_step")]]
    
    await query.edit_message_text(
        f"Шаг {current + 1}/{len(steps)}:\n\n{step}\n\n⏱ Таймер: {minutes} минут",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    
    # Таймер
    asyncio.create_task(send_timer_reminder(query, user_id, minutes, current))

async def send_timer_reminder(query, user_id, minutes, step_num):
    await asyncio.sleep(minutes * 60)
    
    # Проверяем что пользователь всё еще на этом шаге
    if user_id in user_tasks and user_tasks[user_id]['current'] == step_num:
        keyboard = [[InlineKeyboardButton("✅ Готово", callback_data="next_step")]]
        try:
            await query.message.reply_text(
                "⏰ Время вышло! Готово?",
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
        except:
            pass

async def next_step(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    
    if user_id not in user_tasks:
        await query.edit_message_text("Задача не найдена.")
        return
    
    user_tasks[user_id]['current'] += 1
    await send_current_step(query, user_id, context)

def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_task))
    app.add_handler(CallbackQueryHandler(start_steps, pattern="^start_steps$"))
    app.add_handler(CallbackQueryHandler(next_step, pattern="^next_step$"))
    
    print("Бот запущен...")
    app.run_polling()

if __name__ == '__main__':
    main()
