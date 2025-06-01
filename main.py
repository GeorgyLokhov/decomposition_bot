import asyncio
import logging
import os
import pandas as pd
import re
import aiofiles
from io import BytesIO
from typing import Dict, List, Optional, Set
import time
import aiohttp
import hashlib

from aiogram import Bot, Dispatcher, F, types
from aiogram.filters.command import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, BufferedInputFile
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Токен бота
BOT_TOKEN = "7513294224:AAE9BN38NiITd2TmKNrslAprqzyDLWP5vuE"

# Инициализация бота и диспетчера
bot = Bot(token=BOT_TOKEN)
storage = MemoryStorage()
dp = Dispatcher(storage=storage)

# FastAPI приложение для render.com
app = FastAPI()

# Состояния FSM
class ProcessStates(StatesGroup):
    waiting_file = State()
    choose_filters = State()
    select_address_types = State()
    select_new_auto_flag = State()
    processing = State()

# Глобальное хранилище данных пользователей
user_data: Dict[int, Dict] = {}

# Глобальное хранилище для callback_data маппинга
callback_mappings: Dict[str, str] = {}

# === KEEP-ALIVE МЕХАНИЗМ ===
async def keep_alive():
    """Поддержание активности сервера каждые 14 минут"""
    while True:
        try:
            await asyncio.sleep(14 * 60)  # 14 минут
            
            # Самопинг сервера
            async with aiohttp.ClientSession() as session:
                try:
                    async with session.get('https://rozysk-avto-bot.onrender.com/health') as response:
                        if response.status == 200:
                            logger.info("✅ Keep-alive ping successful")
                        else:
                            logger.warning(f"⚠️ Keep-alive ping returned status: {response.status}")
                except Exception as e:
                    logger.error(f"❌ Keep-alive ping failed: {e}")
                    
        except Exception as e:
            logger.error(f"❌ Keep-alive error: {e}")

def generate_callback_id(text: str) -> str:
    """Генерирует короткий ID для callback_data из текста"""
    # Создаем хеш из текста и берем первые 8 символов
    hash_object = hashlib.md5(text.encode())
    return hash_object.hexdigest()[:8]

def register_callback(prefix: str, value: str) -> str:
    """Регистрирует callback_data и возвращает короткий ID"""
    callback_id = f"{prefix}_{generate_callback_id(value)}"
    callback_mappings[callback_id] = value
    return callback_id

def get_callback_value(callback_id: str) -> str:
    """Получает исходное значение по callback ID"""
    return callback_mappings.get(callback_id, "")

# === КОНСТАНТЫ ===
MOSCOW_REGION_CITIES = {
    'москва', 'московская область', 'мо', 'м.о.',
    'балашиха', 'одинцово', 'подольск', 'королёв', 'мытищи', 'химки', 
    'люберцы', 'коломна', 'электросталь', 'красногорск', 'сергиев посад', 
    'щёлково', 'орехово-зуево', 'раменское', 'жуковский', 'пушкино', 
    'железнодорожный', 'домодедово', 'видное', 'ивантеевка', 'сергиев-посад', 
    'фрязино', 'лобня', 'клин', 'воскресенск', 'рошаль', 'кашира', 'чехов', 
    'дмитров', 'ногинск', 'павловский посад', 'талдом', 'яхрома', 
    'красноармейск', 'богородск', 'краснозаводск', 'загорск', 'солнечногорск', 
    'истра', 'реутов', 'долгопрудный', 'наро-фоминск', 'егорьевск', 'можайск',
    'ступино', 'серпухов', 'протвино', 'пущино', 'озёры', 'зарайск',
    'волоколамск', 'шаховская', 'лотошино', 'рузский', 'истринский',
    'красногорский', 'одинцовский', 'наро-фоминский', 'подольский'
}

def is_moscow_region(address: str) -> bool:
    """Проверяет, относится ли адрес к Москве или Подмосковью"""
    if pd.isna(address) or not isinstance(address, str):
        return False
    
    address_lower = address.lower()
    
    # Прямая проверка на наличие ключевых слов
    for city in MOSCOW_REGION_CITIES:
        if city in address_lower:
            return True
    
    # Дополнительные паттерны
    moscow_patterns = [
        r'\bмосква\b', r'\bмосковск\w*\b', r'\bмо\b', r'\bм\.о\.\b',
        r'\bг\.\s*москва\b', r'\bг\.\s*балашиха\b'
    ]
    
    for pattern in moscow_patterns:
        if re.search(pattern, address_lower):
            return True
    
    return False

def smart_clean_address(address):
    """Умная очистка адресов"""
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

def extract_license_plate(text):
    """Извлечение номерных знаков"""
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

    text_clean = text.replace(' ', '').replace(',', ' ').split()
    if not text_clean:
        return ""
    
    text_clean = text_clean[-1]

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

def remove_license_plate(text, plate):
    """Удаление номерного знака из текста"""
    if pd.isna(text) or not isinstance(text, str) or not plate:
        return text
    return text.replace(plate, '').strip()

async def process_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Обработка DataFrame с очисткой адресов и извлечением номеров"""
    
    logger.info(f"Начинаем обработку DataFrame с {len(df)} записями")
    
    # 1. Фильтрация по региону (Москва и Подмосковье)
    address_cols = [col for col in df.columns if any(word in col.lower() 
                   for word in ['адрес', 'address'])]
    
    if address_cols:
        address_col = address_cols[0]
        logger.info(f"Найден столбец с адресами: {address_col}")
        
        # Фильтруем только записи из Москвы и Подмосковья
        moscow_mask = df[address_col].apply(is_moscow_region)
        df = df[moscow_mask].copy()
        logger.info(f"После фильтрации по региону осталось {len(df)} записей")
        
        # Очищаем адреса
        df[address_col] = df[address_col].apply(smart_clean_address)

    # 2. Извлечение номерных знаков
    auto_data_col = "ДАННЫЕ АВТО"
    if auto_data_col in df.columns:
        logger.info(f"Извлекаем номерные знаки из столбца: {auto_data_col}")
        
        auto_data_index = df.columns.get_loc(auto_data_col)
        license_plates = df[auto_data_col].apply(extract_license_plate)
        df.insert(auto_data_index + 1, "НОМЕРНОЙ ЗНАК", license_plates)

        for i in range(len(df)):
            original_text = df.iloc[i][auto_data_col]
            plate = df.iloc[i]["НОМЕРНОЙ ЗНАК"]
            if plate:
                df.iloc[i, df.columns.get_loc(auto_data_col)] = remove_license_plate(original_text, plate)

    logger.info("Обработка DataFrame завершена")
    return df

def get_unique_values(df: pd.DataFrame, column: str) -> List[str]:
    """Получение уникальных значений из столбца"""
    if column not in df.columns:
        return []
    
    unique_vals = df[column].dropna().unique()
    return sorted([str(val) for val in unique_vals if str(val).strip() and str(val) != 'nan'])

def create_filter_keyboard(options: List[str], selected: Set[str], callback_prefix: str) -> InlineKeyboardMarkup:
    """Создание клавиатуры для выбора фильтров с безопасными callback_data"""
    keyboard = []
    
    # Ограничиваем количество опций для удобства
    for option in options[:20]:  # Максимум 20 опций
        status = "✅" if option in selected else "⬜"
        
        # Создаем безопасный callback_data используя индекс
        callback_id = register_callback(callback_prefix, option)
        
        # Обрезаем текст кнопки до 40 символов
        display_text = option[:40] + "..." if len(option) > 40 else option
        
        keyboard.append([InlineKeyboardButton(
            text=f"{status} {display_text}", 
            callback_data=callback_id
        )])
    
    if len(options) > 20:
        keyboard.append([InlineKeyboardButton(
            text=f"... и еще {len(options) - 20} вариантов",
            callback_data="show_more"
        )])
    
    keyboard.append([
        InlineKeyboardButton(text="✔️ Применить фильтры", callback_data="apply_filters"),
        InlineKeyboardButton(text="🔄 Сбросить", callback_data="reset_filters")
    ])
    keyboard.append([InlineKeyboardButton(text="◀️ Назад", callback_data="back_to_filter_choice")])
    
    return InlineKeyboardMarkup(inline_keyboard=keyboard)

@dp.message(Command("start"))
async def cmd_start(message: types.Message, state: FSMContext):
    """Обработчик команды /start"""
    await state.clear()
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📁 Загрузить файл", callback_data="upload_file")]
    ])
    
    welcome_text = """
🚗 **Добро пожаловать в бот обработки данных розыска авто!**

**Возможности бота:**
• 📍 Фильтрация по региону (Москва и Подмосковье)
• 🧹 Умная очистка адресов
• 🔢 Извлечение номерных знаков
• 🗂 Разделение больших файлов на части
• 🎯 Фильтрация по типам адресов и флагам

**Поддерживаемые форматы:** CSV, Excel (.xlsx, .xls)

Нажмите кнопку ниже, чтобы начать!
    """
    
    await message.answer(welcome_text, reply_markup=keyboard, parse_mode='Markdown')

@dp.callback_query(F.data == "upload_file")
async def upload_file_callback(callback: types.CallbackQuery, state: FSMContext):
    """Запрос загрузки файла"""
    await callback.answer()
    
    await callback.message.edit_text(
        "📁 **Загрузите файл для обработки**\n\n"
        "Поддерживаемые форматы: CSV, Excel (.xlsx, .xls)\n"
        "Максимальный размер: 20 МБ",
        parse_mode='Markdown'
    )
    await state.set_state(ProcessStates.waiting_file)

@dp.message(ProcessStates.waiting_file, F.document)
async def handle_file(message: types.Message, state: FSMContext):
    """Обработка загруженного файла"""
    document = message.document
    
    # Проверка формата файла
    if not (document.file_name.endswith(('.csv', '.xlsx', '.xls'))):
        await message.answer("❌ Поддерживаются только CSV и Excel файлы!")
        return
    
    # Проверка размера файла (20 МБ)
    if document.file_size > 20 * 1024 * 1024:
        await message.answer("❌ Файл слишком большой! Максимальный размер: 20 МБ")
        return
    
    loading_msg = await message.answer("⏳ Загружаю и обрабатываю файл...")
    
    try:
        logger.info(f"Получен файл: {document.file_name}, размер: {document.file_size} байт")
        
        # Скачиваем файл
        file_info = await bot.get_file(document.file_id)
        file_content = await bot.download_file(file_info.file_path)
        
        # Читаем данные в память
        file_bytes = file_content.read()
        
        # Читаем файл в DataFrame
        if document.file_name.endswith('.csv'):
            # Пробуем разные кодировки
            encodings = ['utf-8', 'windows-1251', 'cp1251', 'latin-1']
            df = None
            
            for encoding in encodings:
                try:
                    df = pd.read_csv(BytesIO(file_bytes), encoding=encoding)
                    logger.info(f"Файл успешно прочитан с кодировкой: {encoding}")
                    break
                except UnicodeDecodeError:
                    continue
            
            if df is None:
                raise ValueError("Не удалось прочитать CSV файл с поддерживаемыми кодировками")
        else:
            df = pd.read_excel(BytesIO(file_bytes))
        
        logger.info(f"Файл загружен, строк: {len(df)}, столбцов: {len(df.columns)}")
        
        # Обрабатываем DataFrame
        df_processed = await process_dataframe(df)
        
        if len(df_processed) == 0:
            await loading_msg.edit_text(
                "⚠️ После фильтрации по региону (Москва и Подмосковье) не осталось записей!\n\n"
                "Проверьте, что в файле есть данные с адресами в Москве или Московской области."
            )
            await state.clear()
            return
        
        # Сохраняем данные в состоянии
        user_data[message.from_user.id] = {
            'df_original': df_processed,
            'df_filtered': df_processed.copy(),
            'filename': document.file_name,
            'selected_address_types': set(),
            'selected_auto_flags': set()
        }
        
        # Предлагаем выбрать фильтры
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🎯 Да, добавить фильтры", callback_data="add_filters")],
            [InlineKeyboardButton(text="⚡ Нет, сразу выгрузить", callback_data="export_without_filters")]
        ])
        
        await loading_msg.edit_text(
            f"✅ **Файл успешно обработан!**\n\n"
            f"📊 Исходных записей: {len(df)}\n"
            f"📍 После фильтрации по региону: {len(df_processed)}\n\n"
            f"🎯 **Хотите добавить дополнительные фильтры?**",
            reply_markup=keyboard,
            parse_mode='Markdown'
        )
        await state.set_state(ProcessStates.choose_filters)
        
    except Exception as e:
        logger.error(f"Ошибка при обработке файла: {str(e)}")
        await loading_msg.edit_text(f"❌ Ошибка при обработке файла: {str(e)}")
        await state.clear()

@dp.callback_query(F.data == "add_filters")
async def add_filters_callback(callback: types.CallbackQuery, state: FSMContext):
    """Выбор типа фильтров"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные не найдены. Загрузите файл заново.")
        return
    
    df = user_data[user_id]['df_original']
    
    # Проверяем доступные столбцы для фильтрации
    address_cols = [col for col in df.columns if any(word in col.lower() 
                   for word in ['адрес', 'address', 'тип'])]
    auto_flag_cols = [col for col in df.columns if any(word in col.lower() 
                     for word in ['флаг', 'новый', 'flag', 'new'])]
    
    buttons = []
    
    if address_cols:
        buttons.append([InlineKeyboardButton(
            text="📍 Фильтр по типам адресов", 
            callback_data="filter_address_types"
        )])
    
    if auto_flag_cols:
        buttons.append([InlineKeyboardButton(
            text="🚗 Фильтр по флагу нового авто", 
            callback_data="filter_auto_flags"
        )])
    
    if not buttons:
        await callback.message.edit_text(
            "⚠️ В файле не найдены столбцы для фильтрации.\n"
            "Выгружаю файл без дополнительных фильтров..."
        )
        await export_files(callback.message, user_id, state)
        return
    
    buttons.append([InlineKeyboardButton(text="✔️ Применить и выгрузить", callback_data="export_with_filters")])
    buttons.append([InlineKeyboardButton(text="◀️ Назад", callback_data="upload_file")])
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    
    await callback.message.edit_text(
        "🎯 **Выберите тип фильтров:**\n\n"
        "Вы можете настроить фильтры по различным параметрам, "
        "чтобы получить только нужные данные.",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )

@dp.callback_query(F.data == "filter_address_types")
async def filter_address_types_callback(callback: types.CallbackQuery, state: FSMContext):
    """Фильтр по типам адресов"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные не найдены. Загрузите файл заново.")
        return
        
    df = user_data[user_id]['df_original']
    
    # Находим столбец с типами адресов
    address_type_cols = [col for col in df.columns if any(word in col.lower() 
                        for word in ['тип', 'type', 'адрес'])]
    
    if not address_type_cols:
        await callback.message.edit_text("❌ Столбец с типами адресов не найден!")
        return
    
    address_type_col = address_type_cols[0]
    unique_types = get_unique_values(df, address_type_col)
    
    if not unique_types:
        await callback.message.edit_text("❌ В столбце нет данных для фильтрации!")
        return
    
    selected = user_data[user_id]['selected_address_types']
    keyboard = create_filter_keyboard(unique_types, selected, "addr_type")
    
    await callback.message.edit_text(
        f"📍 **Выберите типы адресов:**\n\n"
        f"Столбец: `{address_type_col}`\n"
        f"Доступно вариантов: {len(unique_types)}\n\n"
        f"Нажмите на варианты для выбора/отмены:",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )
    await state.set_state(ProcessStates.select_address_types)

@dp.callback_query(F.data.startswith("addr_type_"))
async def toggle_address_type(callback: types.CallbackQuery, state: FSMContext):
    """Переключение выбора типа адреса"""
    user_id = callback.from_user.id
    callback_id = callback.data
    address_type = get_callback_value(callback_id)
    
    if user_id not in user_data or not address_type:
        await callback.answer("❌ Данные не найдены!")
        return
    
    selected = user_data[user_id]['selected_address_types']
    
    if address_type in selected:
        selected.remove(address_type)
        await callback.answer(f"❌ Отменено: {address_type[:30]}...")
    else:
        selected.add(address_type)
        await callback.answer(f"✅ Выбрано: {address_type[:30]}...")
    
    # Обновляем клавиатуру
    df = user_data[user_id]['df_original']
    address_type_cols = [col for col in df.columns if any(word in col.lower() 
                        for word in ['тип', 'type', 'адрес'])]
    address_type_col = address_type_cols[0]
    unique_types = get_unique_values(df, address_type_col)
    
    keyboard = create_filter_keyboard(unique_types, selected, "addr_type")
    
    await callback.message.edit_reply_markup(reply_markup=keyboard)

@dp.callback_query(F.data == "filter_auto_flags")
async def filter_auto_flags_callback(callback: types.CallbackQuery, state: FSMContext):
    """Фильтр по флагам нового авто"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные не найдены. Загрузите файл заново.")
        return
        
    df = user_data[user_id]['df_original']
    
    # Находим столбец с флагами
    flag_cols = [col for col in df.columns if any(word in col.lower() 
                for word in ['флаг', 'новый', 'flag', 'new'])]
    
    if not flag_cols:
        await callback.message.edit_text("❌ Столбец с флагами не найден!")
        return
    
    flag_col = flag_cols[0]
    unique_flags = get_unique_values(df, flag_col)
    
    if not unique_flags:
        await callback.message.edit_text("❌ В столбце нет данных для фильтрации!")
        return
    
    selected = user_data[user_id]['selected_auto_flags']
    keyboard = create_filter_keyboard(unique_flags, selected, "auto_flag")
    
    await callback.message.edit_text(
        f"🚗 **Выберите флаги нового авто:**\n\n"
        f"Столбец: `{flag_col}`\n"
        f"Доступно вариантов: {len(unique_flags)}\n\n"
        f"Нажмите на варианты для выбора/отмены:",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )
    await state.set_state(ProcessStates.select_new_auto_flag)

@dp.callback_query(F.data.startswith("auto_flag_"))
async def toggle_auto_flag(callback: types.CallbackQuery, state: FSMContext):
    """Переключение выбора флага авто"""
    user_id = callback.from_user.id
    callback_id = callback.data
    auto_flag = get_callback_value(callback_id)
    
    if user_id not in user_data or not auto_flag:
        await callback.answer("❌ Данные не найдены!")
        return
    
    selected = user_data[user_id]['selected_auto_flags']
    
    if auto_flag in selected:
        selected.remove(auto_flag)
        await callback.answer(f"❌ Отменено: {auto_flag[:30]}...")
    else:
        selected.add(auto_flag)
        await callback.answer(f"✅ Выбрано: {auto_flag[:30]}...")
    
    # Обновляем клавиатуру
    df = user_data[user_id]['df_original']
    flag_cols = [col for col in df.columns if any(word in col.lower() 
                for word in ['флаг', 'новый', 'flag', 'new'])]
    flag_col = flag_cols[0]
    unique_flags = get_unique_values(df, flag_col)
    
    keyboard = create_filter_keyboard(unique_flags, selected, "auto_flag")
    
    await callback.message.edit_reply_markup(reply_markup=keyboard)

@dp.callback_query(F.data == "apply_filters")
async def apply_filters_callback(callback: types.CallbackQuery, state: FSMContext):
    """Применение выбранных фильтров"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные не найдены. Загрузите файл заново.")
        return
        
    data = user_data[user_id]
    
    df = data['df_original'].copy()
    selected_addr_types = data['selected_address_types']
    selected_auto_flags = data['selected_auto_flags']
    
    # Применяем фильтры
    if selected_addr_types:
        address_type_cols = [col for col in df.columns if any(word in col.lower() 
                            for word in ['тип', 'type', 'адрес'])]
        if address_type_cols:
            addr_col = address_type_cols[0]
            df = df[df[addr_col].isin(selected_addr_types)]
    
    if selected_auto_flags:
        flag_cols = [col for col in df.columns if any(word in col.lower() 
                    for word in ['флаг', 'новый', 'flag', 'new'])]
        if flag_cols:
            flag_col = flag_cols[0]
            df = df[df[flag_col].isin(selected_auto_flags)]
    
    data['df_filtered'] = df
    
    filter_summary = []
    if selected_addr_types:
        filter_summary.append(f"📍 Типы адресов: {len(selected_addr_types)} выбрано")
    if selected_auto_flags:
        filter_summary.append(f"🚗 Флаги авто: {len(selected_auto_flags)} выбрано")
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📤 Выгрузить файлы", callback_data="export_with_filters")],
        [InlineKeyboardButton(text="🔄 Изменить фильтры", callback_data="add_filters")],
        [InlineKeyboardButton(text="◀️ Назад", callback_data="add_filters")]
    ])
    
    await callback.message.edit_text(
        f"✅ **Фильтры применены!**\n\n"
        f"📊 Записей после фильтрации: {len(df)}\n"
        f"📋 Активные фильтры:\n" + "\n".join(filter_summary) + "\n\n"
        f"Готовы выгрузить файлы?",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )

@dp.callback_query(F.data == "reset_filters")
async def reset_filters_callback(callback: types.CallbackQuery, state: FSMContext):
    """Сброс всех фильтров"""
    await callback.answer("🔄 Все фильтры сброшены!")
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные не найдены. Загрузите файл заново.")
        return
        
    data = user_data[user_id]
    
    data['selected_address_types'].clear()
    data['selected_auto_flags'].clear()
    data['df_filtered'] = data['df_original'].copy()
    
    # Очищаем callback mappings для этого пользователя
    keys_to_remove = [k for k in callback_mappings.keys() if k.startswith(('addr_type_', 'auto_flag_'))]
    for key in keys_to_remove:
        callback_mappings.pop(key, None)
    
    await add_filters_callback(callback, state)

@dp.callback_query(F.data == "back_to_filter_choice")
async def back_to_filter_choice(callback: types.CallbackQuery, state: FSMContext):
    """Возврат к выбору типа фильтров"""
    await callback.answer()
    await add_filters_callback(callback, state)

@dp.callback_query(F.data.in_(["export_without_filters", "export_with_filters"]))
async def export_files_callback(callback: types.CallbackQuery, state: FSMContext):
    """Выгрузка файлов"""
    await callback.answer()
    
    user_id = callback.from_user.id
    await callback.message.edit_text("⏳ Подготавливаю файлы для выгрузки...")
    await export_files(callback.message, user_id, state)

async def export_files(message: types.Message, user_id: int, state: FSMContext):
    """Экспорт файлов с разделением на части"""
    try:
        if user_id not in user_data:
            await message.edit_text("❌ Данные не найдены. Загрузите файл заново.")
            return
            
        data = user_data[user_id]
        df = data['df_filtered']
        filename = data['filename']
        
        total_rows = len(df)
        chunk_size = 2000
        num_parts = (total_rows + chunk_size - 1) // chunk_size
        
        logger.info(f"Начинаем экспорт {total_rows} записей в {num_parts} частях")
        
        # Отправляем инструкцию
        instruction_message = (
            f"📁 **Файлы готовы к загрузке в Google My Maps**\n\n"
            f"📊 Всего записей: {total_rows}\n"
            f"📦 Количество частей: {num_parts}\n\n"
            f"💡 Загружайте каждый файл по отдельности для получения меток на карте."
        )
        
        await message.edit_text(instruction_message, parse_mode='Markdown')
        
        # Создаем и отправляем файлы частями
        for i in range(0, total_rows, chunk_size):
            part_num = (i // chunk_size) + 1
            chunk = df[i:i + chunk_size]
            
            # Создаем CSV в памяти
            output = BytesIO()
            chunk.to_csv(output, index=False, encoding='utf-8')
            output.seek(0)
            
            part_filename = f"{part_num} часть розыска авто.csv"
            
            # Отправляем файл используя BufferedInputFile
            input_file = BufferedInputFile(
                file=output.getvalue(),
                filename=part_filename
            )
            
            await bot.send_document(
                chat_id=user_id,
                document=input_file,
                caption=f"📄 Часть {part_num} из {num_parts}"
            )
            
            logger.info(f"Отправлена часть {part_num}/{num_parts}")
            
            # Небольшая задержка между отправками
            await asyncio.sleep(0.5)
        
        # Предлагаем опции после выгрузки
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🔄 Изменить фильтры и пересоздать", callback_data="add_filters")],
            [InlineKeyboardButton(text="📁 Загрузить новый файл", callback_data="upload_file")],
            [InlineKeyboardButton(text="🏠 В главное меню", callback_data="start")]
        ])
        
        success_message = (
            f"✅ **Выгрузка завершена!**\n\n"
            f"📤 Отправлено файлов: {num_parts}\n"
            f"📊 Всего записей: {total_rows}\n\n"
            f"Что делаем дальше?"
        )
        
        await bot.send_message(
            chat_id=user_id,
            text=success_message,
            reply_markup=keyboard,
            parse_mode='Markdown'
        )
        
        await state.clear()
        logger.info("Экспорт файлов завершен успешно")
        
    except Exception as e:
        logger.error(f"Ошибка при экспорте: {str(e)}")
        await message.edit_text(f"❌ Ошибка при экспорте: {str(e)}")
        await state.clear()

@dp.callback_query(F.data == "start")
async def start_callback(callback: types.CallbackQuery, state: FSMContext):
    """Возврат в главное меню"""
    await callback.answer()
    await state.clear()
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📁 Загрузить файл", callback_data="upload_file")]
    ])
    
    welcome_text = """
🚗 **Добро пожаловать в бот обработки данных розыска авто!**

**Возможности бота:**
• 📍 Фильтрация по региону (Москва и Подмосковье)
• 🧹 Умная очистка адресов
• 🔢 Извлечение номерных знаков
• 🗂 Разделение больших файлов на части
• 🎯 Фильтрация по типам адресов и флагам

**Поддерживаемые форматы:** CSV, Excel (.xlsx, .xls)

Нажмите кнопку ниже, чтобы начать!
    """
    
    await callback.message.edit_text(welcome_text, reply_markup=keyboard, parse_mode='Markdown')

@dp.callback_query(F.data == "show_more")
async def show_more_callback(callback: types.CallbackQuery, state: FSMContext):
    """Обработка нажатия на "показать больше" """
    await callback.answer("💡 Для просмотра всех вариантов используйте поиск по файлу")

# Обработчик других сообщений
@dp.message()
async def other_messages(message: types.Message, state: FSMContext):
    """Обработчик остальных сообщений"""
    current_state = await state.get_state()
    
    if current_state == ProcessStates.waiting_file.state:
        await message.answer(
            "📁 Пожалуйста, отправьте файл документом (CSV или Excel).\n"
            "Или нажмите /start для возврата в главное меню."
        )
    else:
        await message.answer(
            "❓ Не понимаю команду. Нажмите /start для начала работы."
        )

# FastAPI endpoints для render.com
@app.get("/")
async def root():
    """Главная страница - поддерживает GET и HEAD"""
    logger.info("🌐 Root endpoint accessed")
    return {"status": "Bot is running", "message": "Telegram bot is active", "timestamp": time.time()}

@app.head("/")
async def root_head():
    """HEAD запрос для главной страницы"""
    logger.info("📡 HEAD request to root")
    return {}

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    logger.info("🏥 Health check accessed")
    return {"status": "healthy", "timestamp": time.time(), "uptime": "Server is alive"}

@app.head("/health")
async def health_check_head():
    """HEAD запрос для health check"""
    logger.info("📡 HEAD request to health")
    return {}

@app.post("/webhook")
async def webhook(request: Request):
    """Webhook для получения обновлений от Telegram"""
    try:
        data = await request.json()
        update = types.Update(**data)
        await dp.feed_update(bot, update)
        return JSONResponse({"status": "ok"})
    except Exception as e:
        logger.error(f"Webhook error: {e}")
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

async def set_webhook():
    """Установка webhook"""
    try:
        webhook_url = "https://rozysk-avto-bot.onrender.com/webhook"
        await bot.set_webhook(webhook_url)
        logger.info(f"✅ Webhook установлен: {webhook_url}")
    except Exception as e:
        logger.error(f"❌ Ошибка установки webhook: {e}")

# Обработка graceful shutdown
import signal

class GracefulKiller:
    def __init__(self):
        self.kill_now = False
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _handle_signal(self, signum, frame):
        logger.info(f"🛑 Получен сигнал завершения: {signum}")
        self.kill_now = True

async def main():
    """Основная функция запуска"""
    killer = GracefulKiller()
    
    try:
        # Устанавливаем webhook
        await set_webhook()
        
        # Запускаем keep-alive задачу
        keep_alive_task = asyncio.create_task(keep_alive())
        logger.info("🔄 Keep-alive задача запущена")
        
        # Запускаем приложение
        import uvicorn
        config = uvicorn.Config(
            app=app,
            host="0.0.0.0",
            port=int(os.environ.get("PORT", 10000)),
            log_level="info",
            access_log=True
        )
        server = uvicorn.Server(config)
        
        # Запускаем сервер
        logger.info(f"🚀 Запускаем сервер на порту {config.port}")
        server_task = asyncio.create_task(server.serve())
        
        # Ждем завершения
        try:
            await server_task
        except asyncio.CancelledError:
            logger.info("🛑 Сервер остановлен")
        
    except Exception as e:
        logger.error(f"❌ Ошибка запуска: {e}")
    finally:
        try:
            logger.info("🧹 Очистка ресурсов...")
            await bot.delete_webhook()
            await bot.session.close()
            
            # Останавливаем keep-alive задачу
            if 'keep_alive_task' in locals():
                keep_alive_task.cancel()
                try:
                    await keep_alive_task
                except asyncio.CancelledError:
                    pass
                    
        except Exception as e:
            logger.error(f"Ошибка при очистке: {e}")

# Запуск приложения
if __name__ == "__main__":
    asyncio.run(main())
