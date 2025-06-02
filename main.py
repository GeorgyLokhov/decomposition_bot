import asyncio
import logging
import os
import pandas as pd
import re
import gc
from io import BytesIO
from typing import Dict, List, Optional, Set
import time
import aiohttp
import hashlib
import uvicorn

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

# Токен бота из переменных окружения
BOT_TOKEN = os.getenv('BOT_TOKEN')
if not BOT_TOKEN:
    logger.error('❌ BOT_TOKEN не установлен в переменных окружения!')
    raise RuntimeError('BOT_TOKEN не установлен в переменных окружения!')

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

# Глобальное хранилище данных пользователей (УМЕНЬШЕНО!)
user_data: Dict[int, Dict] = {}

# Глобальное хранилище для callback_data маппинга
callback_mappings: Dict[str, str] = {}

# Флаг для контроля работы приложения
is_running = True

def cleanup_memory():
    """Принудительная очистка памяти"""
    gc.collect()
    
def generate_callback_id(text: str) -> str:
    """Генерирует короткий ID для callback_data из текста"""
    hash_object = hashlib.md5(text.encode())
    return hash_object.hexdigest()[:6]  # Еще короче

def register_callback(prefix: str, value: str) -> str:
    """Регистрирует callback_data и возвращает короткий ID"""
    callback_id = f"{prefix}_{generate_callback_id(value)}"
    callback_mappings[callback_id] = value
    return callback_id

def get_callback_value(callback_id: str) -> str:
    """Получает исходное значение по callback ID"""
    return callback_mappings.get(callback_id, "")

# === KEEP-ALIVE BACKGROUND TASK ===
async def keep_alive_background():
    """Фоновая задача для поддержания активности"""
    while is_running:
        try:
            await asyncio.sleep(13 * 60)  # 13 минут (раньше пинговать)
            
            async with aiohttp.ClientSession() as session:
                try:
                    async with session.get('https://rozysk-avto-bot.onrender.com/health', timeout=5) as response:
                        if response.status == 200:
                            logger.info("✅ Keep-alive ping successful")
                        else:
                            logger.warning(f"⚠️ Keep-alive ping returned status: {response.status}")
                except Exception as e:
                    logger.error(f"❌ Keep-alive ping failed: {e}")
                    
        except Exception as e:
            logger.error(f"❌ Keep-alive background task error: {e}")

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
    """ОПТИМИЗИРОВАННАЯ умная очистка адресов"""
    if pd.isna(address):
        return address

    address = str(address).strip()

    # Объединенный паттерн для лучшей производительности
    combined_pattern = r'(,?\s*(кв|квартира|оф|офис|эт|этаж|пом|помещение)\.?\s*\d+|^\d{6},?\s*)'
    address = re.sub(combined_pattern, '', address, flags=re.IGNORECASE)

    # Очистка пробелов и запятых
    address = re.sub(r',+', ',', address)
    address = re.sub(r'\s+', ' ', address)
    address = address.strip(' ,')

    # Проверка наличия города
    has_city = re.search(r'\b(Москва|московская область|мо|м\.о\.)\b', address, re.IGNORECASE)

    if not has_city:
        # Упрощенная проверка МО
        mo_keywords = ['балашиха', 'одинцово', 'подольск', 'королёв', 'мытищи', 'химки']
        is_mo = any(keyword in address.lower() for keyword in mo_keywords)
        
        if is_mo:
            address += ', Московская область, Россия'
        else:
            address += ', Москва, Россия'

    return address

def extract_license_plate_fast(text):
    """БЫСТРОЕ извлечение номерных знаков"""
    if pd.isna(text) or not isinstance(text, str):
        return ""

    # Только основные паттерны для скорости
    patterns = [
        r'[А-Я]\d{3}[А-Я]{2}\d{2,3}',
        r'\d{4}[А-Я]{2}\d{2,3}'
    ]

    for pattern in patterns:
        matches = re.findall(pattern, text.upper())
        if matches:
            return matches[0]

    return ""

async def process_dataframe_optimized(df: pd.DataFrame) -> pd.DataFrame:
    """ОПТИМИЗИРОВАННАЯ обработка DataFrame"""
    
    logger.info(f"Начинаем БЫСТРУЮ обработку {len(df)} записей")
    
    # Принудительная очистка памяти в начале
    cleanup_memory()
    
    # 1. Быстрая фильтрация по региону
    address_col = None
    for col in df.columns:
        if 'адрес' in col.lower() and 'тип' not in col.lower():
            address_col = col
            break
    
    if address_col:
        logger.info(f"Найден столбец с адресами: {address_col}")
        
        # ВЕКТОРИЗОВАННАЯ операция
        moscow_mask = df[address_col].astype(str).str.lower().str.contains(
            '|'.join(MOSCOW_REGION_CITIES), 
            na=False, 
            regex=True
        )
        
        df = df[moscow_mask].copy()
        logger.info(f"После БЫСТРОЙ фильтрации осталось {len(df)} записей")
        
        # Быстрая очистка адресов (только для первых 1000 записей для экономии времени)
        if len(df) <= 1000:
            df[address_col] = df[address_col].apply(smart_clean_address)
        else:
            logger.info("Пропускаем очистку адресов для экономии памяти")

    # 2. Быстрое извлечение номерных знаков
    auto_data_col = "ДАННЫЕ АВТО"
    if auto_data_col in df.columns:
        logger.info(f"Быстро извлекаем номера из {auto_data_col}")
        
        license_plates = df[auto_data_col].apply(extract_license_plate_fast)
        
        # Добавляем столбец ТОЛЬКО если есть номера
        if license_plates.notna().any():
            auto_data_index = df.columns.get_loc(auto_data_col)
            df.insert(auto_data_index + 1, "НОМЕРНОЙ ЗНАК", license_plates)

    logger.info("БЫСТРАЯ обработка завершена")
    
    # Принудительная очистка памяти
    cleanup_memory()
    
    return df

def get_unique_values_fast(df: pd.DataFrame, column: str) -> List[str]:
    """БЫСТРОЕ получение уникальных значений"""
    if column not in df.columns:
        return []
    
    # Ограничиваем до 50 уникальных значений для экономии памяти
    unique_vals = df[column].dropna().unique()[:50]
    return sorted([str(val) for val in unique_vals if str(val).strip() and str(val) != 'nan'])

def create_compact_keyboard(options: List[str], selected: Set[str], callback_prefix: str) -> InlineKeyboardMarkup:
    """Компактная клавиатура (максимум 10 опций)"""
    keyboard = []
    
    # ТОЛЬКО 10 опций максимум
    for option in options[:10]:
        status = "✅" if option in selected else "⬜"
        callback_id = register_callback(callback_prefix, option)
        display_text = option[:25] + "..." if len(option) > 25 else option
        
        keyboard.append([InlineKeyboardButton(
            text=f"{status} {display_text}", 
            callback_data=callback_id
        )])
    
    if len(options) > 10:
        keyboard.append([InlineKeyboardButton(
            text=f"... и еще {len(options) - 10} вариантов",
            callback_data="show_more"
        )])
    
    keyboard.append([
        InlineKeyboardButton(text="✔️ Применить", callback_data="apply_filters"),
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
🚗 **Бот обработки данных розыска авто**

**Функции:**
• 📍 Фильтр: Москва + Подмосковье
• 🧹 Очистка адресов
• 🔢 Извлечение номеров
• 🗂 Разделение на части
• 🎯 Фильтры по типам

**Форматы:** CSV, Excel
**Лимит:** 5 МБ

Жми кнопку! 👇
    """
    
    await message.answer(welcome_text, reply_markup=keyboard, parse_mode='Markdown')

@dp.callback_query(F.data == "upload_file")
async def upload_file_callback(callback: types.CallbackQuery, state: FSMContext):
    """Запрос загрузки файла"""
    await callback.answer()
    
    await callback.message.edit_text(
        "📁 **Загрузите файл**\n\n"
        "Форматы: CSV, Excel\n"
        "Лимит: 5 МБ",
        parse_mode='Markdown'
    )
    await state.set_state(ProcessStates.waiting_file)

@dp.message(ProcessStates.waiting_file, F.document)
async def handle_file(message: types.Message, state: FSMContext):
    """ОПТИМИЗИРОВАННАЯ обработка файла"""
    document = message.document
    
    if not document.file_name.endswith(('.csv', '.xlsx', '.xls')):
        await message.answer("❌ Только CSV и Excel!")
        return
    
    # ЖЕСТКИЙ лимит 5 МБ
    if document.file_size > 5 * 1024 * 1024:
        await message.answer("❌ Максимум 5 МБ!")
        return
    
    loading_msg = await message.answer("⚡ БЫСТРО обрабатываю...")
    
    try:
        logger.info(f"БЫСТРАЯ загрузка: {document.file_name}, {document.file_size} байт")
        
        # Скачиваем
        file_info = await bot.get_file(document.file_id)
        file_content = await bot.download_file(file_info.file_path)
        file_bytes = file_content.read()
        
        # Читаем максимально быстро
        if document.file_name.endswith('.csv'):
            df = pd.read_csv(BytesIO(file_bytes), encoding='utf-8')
        else:
            df = pd.read_excel(BytesIO(file_bytes))
        
        logger.info(f"Загружено: {len(df)} строк, столбцы: {list(df.columns)}")
        
        # Немедленно очищаем память от файла
        del file_bytes, file_content
        cleanup_memory()
        
        # БЫСТРАЯ обработка
        df_processed = await process_dataframe_optimized(df)
        
        if len(df_processed) == 0:
            await loading_msg.edit_text("⚠️ Нет записей по Москве/МО!")
            await state.clear()
            return
        
        # Сохраняем ТОЛЬКО обработанные данные (экономия памяти)
        user_data[message.from_user.id] = {
            'df_filtered': df_processed,  # Только отфильтрованные данные
            'filename': document.file_name,
            'selected_address_types': set(),
            'selected_auto_flags': set()
        }
        
        # Очищаем исходный DataFrame
        del df
        cleanup_memory()
        
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🎯 Добавить фильтры", callback_data="add_filters")],
            [InlineKeyboardButton(text="⚡ Сразу выгрузить", callback_data="export_without_filters")]
        ])
        
        await loading_msg.edit_text(
            f"✅ **ГОТОВО!**\n\n"
            f"📊 Записей: {len(df_processed)}\n\n"
            f"🎯 Добавить фильтры?",
            reply_markup=keyboard,
            parse_mode='Markdown'
        )
        await state.set_state(ProcessStates.choose_filters)
        
    except Exception as e:
        logger.error(f"Ошибка обработки: {str(e)}")
        await loading_msg.edit_text(f"❌ Ошибка: {str(e)}")
        await state.clear()
        cleanup_memory()

@dp.callback_query(F.data == "add_filters")
async def add_filters_callback(callback: types.CallbackQuery, state: FSMContext):
    """Выбор фильтров"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные потеряны. Загрузите заново.")
        return
    
    df = user_data[user_id]['df_filtered']
    
    # ТОЧНЫЙ поиск "ТИП АДРЕСА"
    address_type_col = None
    for col in df.columns:
        if col.upper() == 'ТИП АДРЕСА':
            address_type_col = col
            break
    
    # Поиск флагов
    auto_flag_col = None
    for col in df.columns:
        if 'флаг' in col.lower() and 'авто' in col.lower():
            auto_flag_col = col
            break
    
    buttons = []
    
    if address_type_col:
        buttons.append([InlineKeyboardButton(
            text="📍 Типы адресов", 
            callback_data="filter_address_types"
        )])
    
    if auto_flag_col:
        buttons.append([InlineKeyboardButton(
            text="🚗 Флаги авто", 
            callback_data="filter_auto_flags"
        )])
    
    if not buttons:
        await callback.message.edit_text("⚠️ Нет столбцов для фильтрации. Выгружаю...")
        await export_files_fast(callback.message, user_id, state)
        return
    
    buttons.append([InlineKeyboardButton(text="✔️ Выгрузить", callback_data="export_with_filters")])
    buttons.append([InlineKeyboardButton(text="◀️ Назад", callback_data="upload_file")])
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    
    await callback.message.edit_text(
        "🎯 **Выберите фильтры:**",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )

@dp.callback_query(F.data == "filter_address_types")
async def filter_address_types_callback(callback: types.CallbackQuery, state: FSMContext):
    """Фильтр по типам адресов"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные потеряны!")
        return
        
    df = user_data[user_id]['df_filtered']
    
    # ТОЧНЫЙ поиск столбца "ТИП АДРЕСА"
    address_type_col = None
    for col in df.columns:
        if col.upper() == 'ТИП АДРЕСА':
            address_type_col = col
            break
    
    if not address_type_col:
        await callback.message.edit_text(f"❌ Столбец 'ТИП АДРЕСА' не найден!\n\nДоступные: {list(df.columns)}")
        return
    
    unique_types = get_unique_values_fast(df, address_type_col)
    
    if not unique_types:
        await callback.message.edit_text("❌ Нет данных в столбце!")
        return
    
    selected = user_data[user_id]['selected_address_types']
    keyboard = create_compact_keyboard(unique_types, selected, "addr_type")
    
    await callback.message.edit_text(
        f"📍 **Типы адресов:**\n\n"
        f"Варианты: {', '.join(unique_types[:3])}...\n\n"
        f"Выберите нужные:",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )
    await state.set_state(ProcessStates.select_address_types)

@dp.callback_query(F.data.startswith("addr_type_"))
async def toggle_address_type(callback: types.CallbackQuery, state: FSMContext):
    """Переключение типа адреса"""
    user_id = callback.from_user.id
    address_type = get_callback_value(callback.data)
    
    if user_id not in user_data or not address_type:
        await callback.answer("❌ Ошибка!")
        return
    
    selected = user_data[user_id]['selected_address_types']
    
    if address_type in selected:
        selected.remove(address_type)
        await callback.answer(f"❌ Убрано: {address_type[:20]}...")
    else:
        selected.add(address_type)
        await callback.answer(f"✅ Добавлено: {address_type[:20]}...")
    
    # Обновляем клавиатуру
    df = user_data[user_id]['df_filtered']
    address_type_col = 'ТИП АДРЕСА'  # Точно знаем название
    unique_types = get_unique_values_fast(df, address_type_col)
    keyboard = create_compact_keyboard(unique_types, selected, "addr_type")
    
    try:
        await callback.message.edit_reply_markup(reply_markup=keyboard)
    except:
        pass  # Игнорируем ошибки обновления

@dp.callback_query(F.data == "filter_auto_flags")
async def filter_auto_flags_callback(callback: types.CallbackQuery, state: FSMContext):
    """Фильтр по флагам авто"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные потеряны!")
        return
        
    df = user_data[user_id]['df_filtered']
    
    # Поиск столбца с флагами
    flag_col = None
    for col in df.columns:
        if 'флаг' in col.lower() and 'авто' in col.lower():
            flag_col = col
            break
    
    if not flag_col:
        await callback.message.edit_text("❌ Столбец с флагами не найден!")
        return
    
    unique_flags = get_unique_values_fast(df, flag_col)
    
    if not unique_flags:
        await callback.message.edit_text("❌ Нет данных в столбце!")
        return
    
    selected = user_data[user_id]['selected_auto_flags']
    keyboard = create_compact_keyboard(unique_flags, selected, "auto_flag")
    
    await callback.message.edit_text(
        f"🚗 **Флаги авто:**\n\n"
        f"Выберите нужные:",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )
    await state.set_state(ProcessStates.select_new_auto_flag)

@dp.callback_query(F.data.startswith("auto_flag_"))
async def toggle_auto_flag(callback: types.CallbackQuery, state: FSMContext):
    """Переключение флага авто"""
    user_id = callback.from_user.id
    auto_flag = get_callback_value(callback.data)
    
    if user_id not in user_data or not auto_flag:
        await callback.answer("❌ Ошибка!")
        return
    
    selected = user_data[user_id]['selected_auto_flags']
    
    if auto_flag in selected:
        selected.remove(auto_flag)
        await callback.answer(f"❌ Убрано: {auto_flag[:20]}...")
    else:
        selected.add(auto_flag)
        await callback.answer(f"✅ Добавлено: {auto_flag[:20]}...")
    
    # Обновляем клавиатуру
    df = user_data[user_id]['df_filtered']
    flag_col = None
    for col in df.columns:
        if 'флаг' in col.lower() and 'авто' in col.lower():
            flag_col = col
            break
    
    if flag_col:
        unique_flags = get_unique_values_fast(df, flag_col)
        keyboard = create_compact_keyboard(unique_flags, selected, "auto_flag")
        
        try:
            await callback.message.edit_reply_markup(reply_markup=keyboard)
        except:
            pass

@dp.callback_query(F.data == "apply_filters")
async def apply_filters_callback(callback: types.CallbackQuery, state: FSMContext):
    """Применение фильтров"""
    await callback.answer()
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        await callback.message.edit_text("❌ Данные потеряны!")
        return
        
    data = user_data[user_id]
    df = data['df_filtered'].copy()
    
    selected_addr_types = data['selected_address_types']
    selected_auto_flags = data['selected_auto_flags']
    
    # Применяем фильтры
    if selected_addr_types:
        df = df[df['ТИП АДРЕСА'].isin(selected_addr_types)]
    
    if selected_auto_flags:
        flag_col = None
        for col in df.columns:
            if 'флаг' in col.lower() and 'авто' in col.lower():
                flag_col = col
                break
        if flag_col:
            df = df[df[flag_col].isin(selected_auto_flags)]
    
    data['df_filtered'] = df
    
    filter_summary = []
    if selected_addr_types:
        filter_summary.append(f"📍 Адреса: {len(selected_addr_types)}")
    if selected_auto_flags:
        filter_summary.append(f"🚗 Флаги: {len(selected_auto_flags)}")
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📤 ВЫГРУЗИТЬ", callback_data="export_with_filters")],
        [InlineKeyboardButton(text="🔄 Изменить", callback_data="add_filters")]
    ])
    
    await callback.message.edit_text(
        f"✅ **Фильтры применены!**\n\n"
        f"📊 Записей: {len(df)}\n"
        f"📋 Фильтры: {', '.join(filter_summary)}\n\n"
        f"Готово к выгрузке!",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )

@dp.callback_query(F.data == "reset_filters")
async def reset_filters_callback(callback: types.CallbackQuery, state: FSMContext):
    """Сброс фильтров"""
    await callback.answer("🔄 Сброшено!")
    
    user_id = callback.from_user.id
    
    if user_id not in user_data:
        return
        
    data = user_data[user_id]
    data['selected_address_types'].clear()
    data['selected_auto_flags'].clear()
    
    # Очищаем callback mappings
    keys_to_remove = [k for k in callback_mappings.keys() if k.startswith(('addr_type_', 'auto_flag_'))]
    for key in keys_to_remove:
        callback_mappings.pop(key, None)
    
    await add_filters_callback(callback, state)

@dp.callback_query(F.data == "back_to_filter_choice")
async def back_to_filter_choice(callback: types.CallbackQuery, state: FSMContext):
    """Возврат к фильтрам"""
    await callback.answer()
    await add_filters_callback(callback, state)

@dp.callback_query(F.data.in_(["export_without_filters", "export_with_filters"]))
async def export_files_callback(callback: types.CallbackQuery, state: FSMContext):
    """Выгрузка файлов"""
    await callback.answer()
    
    user_id = callback.from_user.id
    await callback.message.edit_text("⚡ БЫСТРО готовлю файлы...")
    await export_files_fast(callback.message, user_id, state)

async def export_files_fast(message: types.Message, user_id: int, state: FSMContext):
    """БЫСТРАЯ выгрузка файлов"""
    try:
        if user_id not in user_data:
            await message.edit_text("❌ Данные потеряны!")
            return
            
        df = user_data[user_id]['df_filtered']
        
        total_rows = len(df)
        chunk_size = 1500  # Меньше для экономии памяти
        num_parts = (total_rows + chunk_size - 1) // chunk_size
        
        logger.info(f"БЫСТРЫЙ экспорт {total_rows} записей в {num_parts} частях")
        
        await message.edit_text(
            f"📁 **ГОТОВО!**\n\n"
            f"📊 Записей: {total_rows}\n"
            f"📦 Частей: {num_parts}\n\n"
            f"⚡ Отправляю...",
            parse_mode='Markdown'
        )
        
        # Отправляем файлы
        for i in range(0, total_rows, chunk_size):
            part_num = (i // chunk_size) + 1
            chunk = df[i:i + chunk_size]
            
            # Создаем CSV
            output = BytesIO()
            chunk.to_csv(output, index=False, encoding='utf-8')
            output.seek(0)
            
            part_filename = f"{part_num}_розыск_авто.csv"
            
            input_file = BufferedInputFile(
                file=output.getvalue(),
                filename=part_filename
            )
            
            await bot.send_document(
                chat_id=user_id,
                document=input_file,
                caption=f"📄 Часть {part_num}/{num_parts}"
            )
            
            logger.info(f"Отправлена часть {part_num}/{num_parts}")
            
            # Очищаем память
            del chunk, output
            cleanup_memory()
            
            await asyncio.sleep(0.3)  # Короче задержка
        
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="📁 Новый файл", callback_data="upload_file")],
            [InlineKeyboardButton(text="🏠 Главная", callback_data="start")]
        ])
        
        await bot.send_message(
            chat_id=user_id,
            text=f"✅ **ГОТОВО!**\n\n📤 Файлов: {num_parts}\n📊 Записей: {total_rows}",
            reply_markup=keyboard,
            parse_mode='Markdown'
        )
        
        await state.clear()
        logger.info("БЫСТРЫЙ экспорт завершен")
        
        # Очищаем все данные пользователя
        if user_id in user_data:
            del user_data[user_id]
        cleanup_memory()
        
    except Exception as e:
        logger.error(f"Ошибка экспорта: {str(e)}")
        await message.edit_text(f"❌ Ошибка: {str(e)}")
        await state.clear()
        cleanup_memory()

@dp.callback_query(F.data == "start")
async def start_callback(callback: types.CallbackQuery, state: FSMContext):
    """Главное меню"""
    await callback.answer()
    await state.clear()
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📁 Загрузить файл", callback_data="upload_file")]
    ])
    
    await callback.message.edit_text(
        "🚗 **Бот готов!**\n\nЖми 📁 для загрузки файла",
        reply_markup=keyboard,
        parse_mode='Markdown'
    )

@dp.callback_query(F.data == "show_more")
async def show_more_callback(callback: types.CallbackQuery, state: FSMContext):
    """Показать больше"""
    await callback.answer("💡 Показаны основные варианты")

@dp.message()
async def other_messages(message: types.Message, state: FSMContext):
    """Другие сообщения"""
    current_state = await state.get_state()
    
    if current_state == ProcessStates.waiting_file.state:
        await message.answer("📁 Отправьте файл документом или /start")
    else:
        await message.answer("❓ Команда /start для начала")

# FastAPI endpoints
@app.get("/")
async def root():
    cleanup_memory()
    return {"status": "Bot is running", "timestamp": time.time()}

@app.head("/")
async def root_head():
    return {}

@app.get("/health")
async def health_check():
    cleanup_memory()
    return {"status": "healthy", "timestamp": time.time()}

@app.head("/health")
async def health_check_head():
    return {}

@app.post("/webhook")
async def webhook(request: Request):
    try:
        data = await request.json()
        update = types.Update(**data)
        await dp.feed_update(bot, update)
        return JSONResponse({"status": "ok"})
    except Exception as e:
        logger.error(f"Webhook error: {e}")
        return JSONResponse({"status": "error"}, status_code=500)

@app.on_event("startup")
async def startup_event():
    global is_running
    is_running = True
    
    try:
        webhook_url = "https://rozysk-avto-bot.onrender.com/webhook"
        await bot.set_webhook(webhook_url)
        logger.info(f"✅ Webhook: {webhook_url}")
        
        asyncio.create_task(keep_alive_background())
        logger.info("🔄 Keep-alive запущен")
        
    except Exception as e:
        logger.error(f"❌ Startup error: {e}")

@app.on_event("shutdown")
async def shutdown_event():
    global is_running
    is_running = False
    
    try:
        await bot.delete_webhook()
        await bot.session.close()
        cleanup_memory()
    except Exception as e:
        logger.error(f"❌ Shutdown error: {e}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    logger.info(f"🚀 Запуск на порту {port}")
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=True
    )
