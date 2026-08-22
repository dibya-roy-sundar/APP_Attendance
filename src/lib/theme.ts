export const THEME_KEY = 'att_theme'
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * What the app shows when nobody has chosen yet.
 *
 * Dark by default because that is what was asked for. Change this one value to
 * `'system'` to follow each device's own setting instead.
 */
export const DEFAULT_MODE: ThemeMode = 'dark'

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

/**
 * Runs before first paint, inlined into the document.
 *
 * Kept as a string rather than an imported function because it has to execute
 * synchronously ahead of any React hydration — otherwise the light palette
 * paints for a frame and the screen flashes white.
 */
export const THEME_SCRIPT = `(function(){try{
var m=localStorage.getItem('${THEME_KEY}');
if(m!=='light'&&m!=='dark'&&m!=='system')m='${DEFAULT_MODE}';
var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var r=document.documentElement;
r.setAttribute('data-theme',d?'dark':'light');
r.style.colorScheme=d?'dark':'light';
}catch(e){
document.documentElement.setAttribute('data-theme','${DEFAULT_MODE}');
}})();`

/** Applies a mode to the document and remembers it. */
export function applyTheme(mode: ThemeMode) {
  const dark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  root.style.colorScheme = dark ? 'dark' : 'light'

  // Keep the browser chrome in step; a light address bar over a dark page is
  // the giveaway that a theme toggle was bolted on.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', dark ? '#0b1120' : '#f8fafc')
    meta.removeAttribute('media')
  }

  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    // Private browsing with storage blocked: the choice lasts this visit only.
  }
}

export function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isThemeMode(stored) ? stored : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}
