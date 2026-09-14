import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    // 允许用局域网 IP / 主机名访问（否则会 Host not allowed）
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
        // 保留浏览器真实 Origin，后端可按 IP 改写 OnlyOffice 地址
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin || req.headers.referer
            if (origin) proxyReq.setHeader('Origin', Array.isArray(origin) ? origin[0] : origin)
            const ip = req.socket.remoteAddress || ''
            if (ip) {
              proxyReq.setHeader('X-Real-IP', ip)
              proxyReq.setHeader('X-Forwarded-For', ip)
            }
          })
        },
      },
      '/healthz': { target: 'http://127.0.0.1:8088', changeOrigin: true },
      '/readyz': { target: 'http://127.0.0.1:8088', changeOrigin: true },
    },
  },
  preview: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@tiptap/extension-table/kit',
      '@tiptap/extension-code-block-lowlight',
      'lowlight',
      'highlight.js',
      'turndown',
      'marked',
      'marked-highlight',
      'dompurify',
    ],
  },
})
