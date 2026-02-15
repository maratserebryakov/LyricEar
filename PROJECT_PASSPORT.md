# ПАСПОРТ ПРОЕКТА — LyricEar
# Последнее обновление: [текущая дата]

## 1. Суть проекта
Веб-приложение для изучения языков на слух через музыку.
Пользователь слушает песню и заполняет пропуски в тексте.

## 2. Структура файлов
- index.html — главная страница (выбор песни)
- player.html — страница плеера (прослушивание + упражнение)
- styles.css — общие стили
- app.js — логика главной страницы
- player.js — логика плеера
- /songs/ — папка с JSON-файлами песен

## 3. Дизайн
- Тёмная тема (фон ~#0e0b1a / #111)
- Цветовая палитра: фиолетовый (#7c3aed, #a855f7), 
  циан (#22d3ee, #06b6d4), зелёный (#34d399), розовый (#f0abfc)
- CSS-переменные: --bg, --surface, --text, --muted, --accent и т.д.

## 4. Логотип (описание под сомнением)
- SVG-иконка: круг с градиентной обводкой, 3 пологие арки 
  (фиолет→циан→зелёный), крупная розовая точка с ореолом,
  разноцветные волны внизу (сирень + циан + зелень)
- Текст "LyricEar": font-weight 800, 
  градиент ДИАГОНАЛЬНЫЙ 135° (#a855f7 → #c084fc → #22d3ee → #06b6d4)
- Подпись "учим языки на слух": цвет --muted
- ⚠️ ЭТАЛОННЫЙ КОД ЛОГОТИПА 
его css часть
/* ═══ Logo ═══ */
.logo-link {
  display: inline-flex; align-items: center; gap: 10px;
  text-decoration: none; color: inherit; margin-bottom: 12px;
  transition: opacity 150ms ease;
}
.logo-link:hover { opacity: 0.85; }
.logo-svg { flex-shrink: 0; }
.logo-text { display: flex; flex-direction: column; gap: 1px; }
.logo-name {
  font-size: 18px; font-weight: 800;
  background: linear-gradient(135deg, #c084fc, #22d3ee, #34d399);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text; line-height: 1.15;
}
.logo-sub { font-size: 11px; color: #71717a; letter-spacing: 0.5px; }


и  html

 <!-- Logo SVG — для index.html и player.html -->
<div id="logoBar" class="logo-bar">
  <a href="/" class="logo-link">
  <svg class="logo-svg" width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- dark circle base -->
    <circle cx="22" cy="22" r="21" fill="#111118" stroke="url(#logoRim)" stroke-width="1"/>
    <!-- aurora arcs -->
    <path d="M8 28 C12 14, 20 10, 22 10 C24 10, 32 14, 36 28"
          stroke="url(#auroraG)" stroke-width="1.2" fill="none" opacity="0.9"/>
    <path d="M10 30 C14 18, 19 14, 22 14 C25 14, 30 18, 34 30"
          stroke="url(#auroraG)" stroke-width="0.8" fill="none" opacity="0.5"/>
    <path d="M12 32 C15 22, 19 18, 22 18 C25 18, 29 22, 32 32"
          stroke="url(#auroraG)" stroke-width="0.6" fill="none" opacity="0.3"/>
    <!-- sound wave -->
    <path d="M10 33 Q14 30, 16 33 T22 33 T28 33 T34 33"
          stroke="#c084fc" stroke-width="1" fill="none" opacity="0.7"/>
    <path d="M12 36 Q16 34, 18 36 T24 36 T30 36"
          stroke="#22d3ee" stroke-width="0.6" fill="none" opacity="0.4"/>
    <!-- star dot -->
    <circle cx="22" cy="11" r="1.2" fill="#f0abfc" opacity="0.9"/>
    <defs>
      <linearGradient id="logoRim" x1="0" y1="0" x2="44" y2="44">
        <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.4"/>
        <stop offset="50%" stop-color="#22d3ee" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#34d399" stop-opacity="0.4"/>
      </linearGradient>
      <linearGradient id="auroraG" x1="8" y1="28" x2="36" y2="10">
        <stop offset="0%" stop-color="#7c3aed"/>
        <stop offset="50%" stop-color="#22d3ee"/>
        <stop offset="100%" stop-color="#34d399"/>
      </linearGradient>
    </defs>
  </svg>
  <span class="logo-text">
    <span class="logo-name">LyricEar</span>
    <span class="logo-sub">учим языки на слух</span>
  </span>
</a>
</div>
## 5. Формат данных песни (JSON)
{
  "id": "...",
  "title": "...",
  "artist": "...",
  "language": "en",
  "audioUrl": "...",
  "lines": [
    {
      "time": 12.5,
      "text": "Some lyrics here",
      "blanks": [{ "word": "lyrics", "index": 1 }]
    }
  ]
}

## 6. Ключевые решения
- Аудио: HTML5 <audio> элемент
- Синхронизация: по таймкодам из JSON
- Пропуски: случайный выбор слов или заданный в JSON
- Проверка: посимвольная, без учёта регистра
- [дополнить по мере развития]

## 7. Нерешённые вопросы
- Эталонный SVG-код логотипа (будет добавлен)
- [дополнить]
