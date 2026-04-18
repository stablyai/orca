import { jsx as _jsx } from "react/jsx-runtime";
import './assets/main.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
if (import.meta.env.DEV) {
    import('react-grab').then(({ init }) => init());
    import('react-grab/styles.css');
}
// Respect system dark mode preference
function applySystemTheme() {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', isDark);
}
applySystemTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySystemTheme);
createRoot(document.getElementById('root')).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
