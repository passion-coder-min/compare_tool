import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// 非 Tauri 环境（浏览器直接打开 vite dev）时启用 mock，便于纯浏览器调试 UI
if (!('__TAURI_INTERNALS__' in window)) {
  import('./lib/mock').then(({ installTauriMock, presetDemoSources }) => {
    installTauriMock();
    presetDemoSources();
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
