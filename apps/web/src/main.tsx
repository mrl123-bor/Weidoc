import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// 不使用 StrictMode：OnlyOffice 会改写 DOM，StrictMode 双挂载容易触发 insertBefore 报错
createRoot(document.getElementById('root')!).render(<App />)
