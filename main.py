import logging
import pandas as pd
import re
import os
import tempfile
import asyncio
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

# Настройка логирования
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Токен бота (будет установлен как переменная окружения)
BOT_TOKEN = os.getenv('BOT_TOKEN')

class FileProcessor:
    @staticmethod
    def smart_clean_address(address):
        if pd.isna(address):
            return address

        address = str(address).strip()

        patterns_to_remove = [
            r',?\s*кв\.?\s*\d+', r',?\s*квартира\s*\d+',
            r',?\s*оф\.?\s*\d+', r',?\s*офис\s*\d+',
            r',?\s*эт\.?\s*\d+', r',?\s*этаж\s*\d+',
            r',?\s*пом\.?\s*\d+', r',?\s*помещение\s*\d+',
            r'^\d{6},?\s*',
        ]

        for pattern in patterns_to_remove:
            address = re.sub(pattern, '', address, flags=re.IGNORECASE)

        address = re.sub(r',+', ',', address)
        address = re.sub(r'\s+', ' ', address)
        address = address.strip(' ,')

        has_city = re.search(r'\b(Москва|московская область|москва|мо|м\.о\.)\b', address, re.IGNORECASE)

        if not has_city:
            mo_indicators = [
                r'\b(балашиха|одинцово|подольск|королёв|мытищи|химки|люберцы|коломна|электросталь|красногорск|сергиев посад|щёлково|орехово-зуево|раменское|жуковский|пушкино|железнодорожный|домодедово|видное|ивантеевка|сергиев-посад|фрязино|лобня|клин|воскресенск|рошаль|кашира|чехов|дмитров|ногинск|павловский посад|талдом|яхрома|красноармейск|богородск|краснозаводск|загорск|солнечногорск|истра)\b',
                r'\bг\.?\s*(балашиха|одинцово|подольск)',
                r'\b(московская обл|мо)\b'
            ]

            is_mo = any(re.search(pattern, address, re.IGNORECASE) for pattern in mo_indicators)

            if is_mo:
                address += ', Московская область, Россия'
            else:
                address += ', Москва, Россия'

        return address

    @staticmethod
    def extract_license_plate(text):
        if pd.isna(text) or not isinstance(text, str):
            return ""

        patterns = [
            r'[А-Я]\d{3}[А-Я]{2}\d{2,3}',
            r'\d{4}[А-Я]{2}\d{2,3}',
            r'[А-Я]{1,2}\d{3,4}[А-Я]{1,2}\d{2,3}'
        ]

        found_plates = []
        for pattern in patterns:
            matches = re.findall(pattern, text.upper())
            found_plates.extend(matches)

        if found_plates:
            return found_plates[0]

        text_clean = text.replace(' ', '').replace(',', ' ').split()[-1]

        if len(text_clean) >= 8:
            last_3 = text_clean[-3:]

            if (len(last_3) == 3 and
                last_3[0].isdigit() and
                last_3[1].isdigit() and
                last_3[2].isalpha()):
                return text_clean[-8:] if len(text_clean) >= 8 else text_clean

            elif (len(last_3) == 3 and
                  last_3[0].isdigit() and
                  last_3[1].isdigit() and
                  last_3[2].isdigit()):
                return text_clean[-9:] if len(text_clean) >= 9 else text_clean

        return ""

    @staticmethod
    def remove_license_plate(text, plate):
        if pd.isna(text) or not isinstance(text, str) or not plate:
            return text
        return text.replace(plate, '').strip()

    @staticmethod
    def process_file(file_path):
        try:
            # Читаем файл
            if file_path.endswith('.csv'):
                df = pd.read_csv(file_path, encoding='utf-8')
            elif file_path.endswith(('.xlsx', '.xls')):
                df = pd.read_excel(file_path)
            else:
                return None, "❌ Поддерживаются только CSV и Excel файлы!"

            # Умная очистка адресов
            address_cols = [col for col in df.columns if any(word in col.lower()
                              for word in ['адрес', 'address'])]

            if address_cols:
                address_col = address_cols[0]
                df[address_col] = df[address_col].apply(FileProcessor.smart_clean_address)

            # Извлечение номерных знаков
            auto_data_col = "ДАННЫЕ АВТО"
            if auto_data_col in df.columns:
                auto_data_index = df.columns.get_loc(auto_data_col)
                license_plates = df[auto_data_col].apply(FileProcessor.extract_license_plate)
                df.insert(auto_data_index + 1, "НОМЕРНОЙ ЗНАК", license_plates)

                for i in range(len(df)):
                    original_text = df.loc[i, auto_data_col]
                    plate = df.loc[i, "НОМЕРНОЙ ЗНАК"]
                    if plate:
                        df.loc[i, auto_data_col] = FileProcessor.remove_license_plate(original_text, plate)

            return df, None

        except Exception as e:
            return None, f"❌ Ошибка обработки файла: {str(e)}"

# Команды бота
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🚗 Добро пожаловать в бот для обработки файлов розыска авто!\n\n"
        "📁 Отправьте мне файл Excel (.xlsx, .xls) или CSV (.csv) и я:\n"
        "✅ Очищу адреса\n"
        "✅ Извлеку номерные знаки\n"
        "✅ Разделю на части по 2000 строк\n"
        "✅ Отправлю готовые файлы для загрузки в Google My Maps\n\n"
        "Просто отправьте файл!"
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🆘 Инструкция по использованию:\n\n"
        "1️⃣ Отправьте файл Excel или CSV\n"
        "2️⃣ Дождитесь обработки\n"
        "3️⃣ Получите готовые части файла\n"
        "4️⃣ Загрузите каждую часть в Google My Maps\n\n"
        "❓ Поддерживаемые форматы: .xlsx, .xls, .csv"
    )

async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message.document:
        await update.message.reply_text("❌ Пожалуйста, отправьте файл!")
        return

    file = update.message.document
    
    # Проверяем формат файла
    if not any(file.file_name.lower().endswith(ext) for ext in ['.xlsx', '.xls', '.csv']):
        await update.message.reply_text("❌ Поддерживаются только файлы Excel (.xlsx, .xls) и CSV (.csv)")
        return

    # Показываем, что файл обрабатывается
    processing_message = await update.message.reply_text("⏳ Обрабатываю файл, подождите...")

    try:
        # Скачиваем файл
        file_obj = await context.bot.get_file(file.file_id)
        
        # Создаем временную директорию
        with tempfile.TemporaryDirectory() as temp_dir:
            # Путь для скачанного файла
            input_file_path = os.path.join(temp_dir, file.file_name)
            
            # Скачиваем файл
            await file_obj.download_to_drive(input_file_path)
            
            # Обрабатываем файл
            df, error = FileProcessor.process_file(input_file_path)
            
            if error:
                await processing_message.edit_text(error)
                return
            
            # Разделяем на части
            total_rows = len(df)
            chunk_size = 2000
            num_parts = (total_rows + chunk_size - 1) // chunk_size
            
            await processing_message.edit_text(
                f"📊 Файл обработан!\n"
                f"Всего строк: {total_rows}\n"
                f"Частей: {num_parts}\n\n"
                f"📤 Отправляю файлы..."
            )
            
            # Отправляем инструкцию
            instruction_message = (
                f"📁 Файлы готовы к загрузке в Google My Maps.\n\n"
                f"💡 Загружайте каждый файл по отдельности для получения меток на карте."
            )
            await update.message.reply_text(instruction_message)
            
            # Создаем и отправляем части
            for i in range(0, total_rows, chunk_size):
                part_num = (i // chunk_size) + 1
                chunk = df[i:i + chunk_size]
                
                # Создаем файл части
                part_filename = f"{part_num} часть розыска авто.csv"
                part_file_path = os.path.join(temp_dir, part_filename)
                chunk.to_csv(part_file_path, index=False, encoding='utf-8')
                
                # Отправляем файл
                with open(part_file_path, 'rb') as f:
                    await context.bot.send_document(
                        chat_id=update.effective_chat.id,
                        document=f,
                        filename=part_filename,
                        caption=f"📄 Часть {part_num} из {num_parts}"
                    )
                
                # Небольшая задержка между отправками
                await asyncio.sleep(1)
            
            await update.message.reply_text("✅ Все файлы отправлены! Теперь можете загружать их в Google My Maps.")
            
    except Exception as e:
        logger.error(f"Error processing file: {e}")
        await processing_message.edit_text(f"❌ Произошла ошибка при обработке файла: {str(e)}")

def main():
    # Создаем приложение
    application = Application.builder().token(BOT_TOKEN).build()

    # Добавляем обработчики команд
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    
    # Обработчик документов
    application.add_handler(MessageHandler(filters.Document.ALL, handle_document))

    # Запускаем бота
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == '__main__':
    main()
