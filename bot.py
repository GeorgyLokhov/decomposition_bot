import os
import re
import pandas as pd
from flask import Flask, request
import telebot
import threading

# === Настройки бота ===
TOKEN = '7513294224:AAE9BN38NiITd2TmKNrslAprqzyDLWP5vuE'  # заменить на свой
bot = telebot.TeleBot(TOKEN)
app = Flask(__name__)

# === Города для фильтрации ===
MOSCOW_REGION_CITIES = {
    "Москва", "москва", "г. москва",
    "Подольск", "Балашиха", "Красногорск", "Химки", "Одинцово",
    "Люберцы", "Мытищи", "Коломна", "Электросталь", "Щелково",
    "Раменское", "Жуковский", "Пушкино", "Железнодорожный",
    "Домодедово", "Ивантеевка", "Сергиев Посад", "Фрязино",
    "Лобня", "Клин", "Воскресенск", "Рошаль", "Кашин",
    "Чехов", "Дмитров", "Ногинск", "Павловский Посад", "Талдом"
}

# === Вспомогательные переменные ===
user_states = {}  # состояние пользователя: шаг, данные, фильтры


# === Умная очистка адреса ===
def smart_clean_address(address):
    if pd.isna(address):
        return address
    address = str(address).strip()

    patterns_to_remove = [
        r',?\s*кв\.?\s*\d+', r',?\s*квартира\s*\d+',
        r',?\s*оф\.?\s*\d+', r',?\s*офис\s*\d+',
        r',?\s*эт\.?\s*\d+', r',?\s*этаж\s*\d+',
        r',?\s*пом\.?\s*\d+', r',?\s*помещение\s*\d+',
        r'^\d{6},?\s*'
    ]

    for pattern in patterns_to_remove:
        address = re.sub(pattern, '', address, flags=re.IGNORECASE)

    address = re.sub(r',+', ',', address)
    address = re.sub(r'\s+', ' ', address).strip(' ,')

    has_city = re.search(r'\b(Москва|московская область|м\.о\.)\b', address, re.IGNORECASE)
    if not has_city:
        is_mo = any(city.lower() in address.lower() for city in MOSCOW_REGION_CITIES)
        if is_mo:
            address += ', Московская область, Россия'
        else:
            address += ', Москва, Россия'

    return address


# === Извлечение номерного знака ===
def extract_license_plate(text):
    if pd.isna(text) or not isinstance(text, str):
        return ""
    text_upper = text.upper()
    patterns = [
        r'[А-Я]\d{3}[А-Я]{2}\d{2,3}',
        r'\d{4}[А-Я]{2}\d{2,3}',
        r'[А-Я]{1,2}\d{3,4}[А-Я]{1,2}\d{2,3}'
    ]
    found_plates = []
    for pattern in patterns:
        found_plates.extend(re.findall(pattern, text_upper))
    return found_plates[0] if found_plates else ""


# === Основная функция обработки файла ===
def process_file(df, filters=None):
    address_cols = [col for col in df.columns if any(word in col.lower() for word in ['адрес', 'address'])]
    if address_cols:
        address_col = address_cols[0]
        df[address_col] = df[address_col].apply(smart_clean_address)

    auto_data_col = "ДАННЫЕ АВТО"
    if auto_data_col in df.columns:
        license_plates = df[auto_data_col].apply(extract_license_plate)
        auto_data_index = df.columns.get_loc(auto_data_col)
        df.insert(auto_data_index + 1, "НОМЕРНОЙ ЗНАК", license_plates)

    # === Фильтрация ===
    if filters:
        address_col = [col for col in df.columns if any(word in col.lower() for word in ['адрес', 'address'])][0]
        if 'address_types' in filters:
            df = df[df[address_col].str.contains('|'.join(filters['address_types']), case=False, na=False)]
        if 'new_car_only' in filters and filters['new_car_only']:
            df = df[df["ДАННЫЕ АВТО"].str.contains("новый", case=False, na=False)]

    return df


# === Обработка команды /start ===
@bot.message_handler(commands=['start'])
def start(message):
    user_states[message.chat.id] = {'step': 'upload'}
    bot.send_message(message.chat.id, "📥 Загрузите CSV или Excel файл")


# === Обработка загрузки файла ===
@bot.message_handler(content_types=['document'])
def handle_document(message):
    chat_id = message.chat.id
    file_info = bot.get_file(message.document.file_id)
    downloaded_file = bot.download_file(file_info.file_path)

    file_name = message.document.file_name
    with open(file_name, 'wb') as new_file:
        new_file.write(downloaded_file)

    try:
        if file_name.endswith('.csv'):
            df = pd.read_csv(file_name, encoding='utf-8')
        elif file_name.endswith(('.xlsx', '.xls')):
            df = pd.read_excel(file_name)
        else:
            bot.send_message(chat_id, "❌ Неподдерживаемый формат файла")
            return
    except Exception as e:
        bot.send_message(chat_id, f"❌ Ошибка чтения файла: {e}")
        return

    # Очистка данных
    cleaned_df = process_file(df)

    # Сохраняем исходный DataFrame
    user_states[chat_id]['df'] = cleaned_df
    user_states[chat_id]['step'] = 'ask_filters'

    markup = telebot.types.ReplyKeyboardMarkup(one_time_keyboard=True)
    markup.add('✅ Да', '❌ Нет')
    bot.send_message(chat_id, "❓ Применить дополнительные фильтры?", reply_markup=markup)


# === Обработка ответа о фильтрах ===
@bot.message_handler(func=lambda msg: user_states.get(msg.chat.id, {}).get('step') == 'ask_filters')
def handle_filters_choice(message):
    chat_id = message.chat.id
    answer = message.text.strip()

    if answer == '✅ Да':
        user_states[chat_id]['step'] = 'choose_address_type'
        address_col = [col for col in user_states[chat_id]['df'].columns if any(word in col.lower() for word in ['адрес', 'address'])][0]
        unique_addresses = user_states[chat_id]['df'][address_col].dropna().unique()

        markup = telebot.types.ReplyKeyboardMarkup(one_time_keyboard=False)
        for addr in sorted(set(unique_addresses))[:20]:  # ограничение для примера
            markup.add(addr.split(',')[0].strip())
        markup.add("✔️ Готово", "⬅️ Назад")

        bot.send_message(chat_id, "📌 Выберите тип(ы) адреса:", reply_markup=markup)
    elif answer == '❌ Нет':
        export_and_send_files(chat_id, user_states[chat_id]['df'])
    else:
        bot.send_message(chat_id, "❌ Неизвестный ответ")


# === Выбор типа адреса ===
@bot.message_handler(func=lambda msg: user_states.get(msg.chat_id, {}).get('step') == 'choose_address_type')
def handle_address_type(message):
    chat_id = message.chat.id
    choice = message.text.strip()

    if choice == "✔️ Готово":
        user_states[chat_id]['step'] = 'choose_new_car_flag'
        markup = telebot.types.ReplyKeyboardMarkup(one_time_keyboard=True)
        markup.add('✅ Да', '❌ Нет')
        bot.send_message(chat_id, "❓ Только новые авто?", reply_markup=markup)
        return

    if choice == "⬅️ Назад":
        user_states[chat_id]['step'] = 'ask_filters'
        markup = telebot.types.ReplyKeyboardMarkup(one_time_keyboard=True)
        markup.add('✅ Да', '❌ Нет')
        bot.send_message(chat_id, "❓ Применить дополнительные фильтры?", reply_markup=markup)
        return

    filters = user_states[chat_id].get('filters', {})
    address_types = filters.get('address_types', set())

    if choice in address_types:
        address_types.remove(choice)
    else:
        address_types.add(choice)

    filters['address_types'] = address_types
    user_states[chat_id]['filters'] = filters

    bot.send_message(chat_id, f"Выбрано: {', '.join(address_types)}")


# === Флаг новых авто ===
@bot.message_handler(func=lambda msg: user_states.get(msg.chat.id, {}).get('step') == 'choose_new_car_flag')
def handle_new_car_flag(message):
    chat_id = message.chat.id
    choice = message.text.strip()

    filters = user_states[chat_id].get('filters', {})
    if choice == '✅ Да':
        filters['new_car_only'] = True
    elif choice == '❌ Нет':
        filters['new_car_only'] = False

    user_states[chat_id]['filters'] = filters
    final_df = process_file(user_states[chat_id]['df'], filters)
    export_and_send_files(chat_id, final_df)


# === Экспорт и отправка файлов ===
def export_and_send_files(chat_id, df):
    chunk_size = 2000
    num_parts = (len(df) + chunk_size - 1) // chunk_size

    temp_dir = 'temp_exports'
    os.makedirs(temp_dir, exist_ok=True)

    part_files = []
    for i in range(0, len(df), chunk_size):
        part_num = (i // chunk_size) + 1
        part_df = df[i:i + chunk_size]
        filename = f"{temp_dir}/{part_num}_часть_розыска_авто.csv"
        part_df.to_csv(filename, index=False, encoding='utf-8-sig')
        part_files.append(filename)

    for file in part_files:
        with open(file, 'rb') as f:
            bot.send_document(chat_id, f)

    markup = telebot.types.ReplyKeyboardMarkup(one_time_keyboard=True)
    markup.add("🔁 Перевыбрать фильтры")
    bot.send_message(chat_id, "✅ Файлы отправлены. Хотите изменить фильтры?", reply_markup=markup)
    user_states[chat_id]['step'] = 'restart'


# === Перезапуск ===
@bot.message_handler(func=lambda msg: user_states.get(msg.chat.id, {}).get('step') == 'restart')
def restart(message):
    chat_id = message.chat.id
    if message.text.strip() == "🔁 Перевыбрать фильтры":
        user_states[chat_id]['step'] = 'ask_filters'
        user_states[chat_id]['filters'] = {}
        markup = telebot.types.ReplyKeyboardMarkup(one_time_keyboard=True)
        markup.add('✅ Да', '❌ Нет')
        bot.send_message(chat_id, "❓ Применить дополнительные фильтры?", reply_markup=markup)


# === Webhook handler ===
@app.route(f"/{TOKEN}", methods=["POST"])
def webhook():
    update = telebot.types.Update.de_json(request.stream.read().decode("utf-8"))
    bot.process_new_updates([update])
    return "OK", 200


# === Запуск сервера ===
@app.route("/")
def index():
    return "Bot is running", 200


if __name__ == "__main__":
    thread = threading.Thread(target=bot.polling)
    thread.start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
