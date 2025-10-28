import os
import json
import asyncio
import queue
import threading
from flask import Flask, request
from telegram import Update, Bot, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes
import google.generativeai as genai

# Токены
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GEMINI_KEY = os.getenv("GEMINI_KEY")
WEBHOOK_URL = os.getenv("RENDER_EXTERNAL_URL", "https://rozysk-avto-bot.onrender.com") + "/webhook"

# Настройка Gemini
genai.configure(api_key=GEMINI_KEY)
model = genai.GenerativeModel('gemini-1.5-flash')

app = Flask(__name__)

# Хранилище задач
user_tasks = {}
update_queue = queue.Queue()
application = None
bot_loop = None

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Отправь мне задачу, я разобью её на абсурдно простые шаги по 5-10 минут.\n\n"
        "Например: 'написать статью про AI' или 'разобрать почту'"
    )

async def handle_task(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    task_text = update.message.text
    
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
        # Запрос к Gemini
        response = model.generate_content(prompt)
        steps_text = response.text
        
        steps = [line.strip() for line in steps_text.split('\n') if line.strip().startswith('Шаг')]
        
        if not steps:
            await update.message.reply_text("Не смог распарсить шаги. Попробуй переформулировать задачу.")
            return
        
        user_tasks[user_id] = {'steps': steps, 'current': 0, 'task_name': task_text}
        
        steps_list = '\n'.join(steps)
        keyboard = [[InlineKeyboardButton("▶️ Начать", callback_data="start_steps")]]
        
        await update.message.reply_text(
            f"📋 Задача: {task_text}\n\n{steps_list}",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    except Exception as e:
        print(f"Error in handle_task: {e}")
        await update.message.reply_text("Произошла ошибка. Попробуй ещё раз.")

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
    minutes = 5
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
    
    asyncio.create_task(send_timer_reminder(query, user_id, minutes, current))

async def send_timer_reminder(query, user_id, minutes, step_num):
    await asyncio.sleep(minutes * 60)
    
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

# Настройка приложения Telegram
async def setup_application():
    global application
    application = Application.builder().token(TELEGRAM_TOKEN).build()
    
    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_task))
    application.add_handler(CallbackQueryHandler(start_steps, pattern="^start_steps$"))
    application.add_handler(CallbackQueryHandler(next_step, pattern="^next_step$"))
    
    await application.initialize()
    await application.start()
    print("✅ Telegram application initialized")

async def setup_webhook():
    try:
        bot = Bot(token=TELEGRAM_TOKEN)
        await bot.initialize()
        result = await bot.set_webhook(url=WEBHOOK_URL)
        await bot.shutdown()
        print(f"✅ Webhook set: {WEBHOOK_URL} -> {result}")
    except Exception as e:
        print(f"❌ Error setting webhook: {e}")

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
