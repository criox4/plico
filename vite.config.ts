import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev/preview the web app reaches the API same-origin at /api (run `npm run server` alongside).
const proxy = { '/api': 'http://localhost:8787' }

export default defineConfig({ plugins: [react()], server: { proxy }, preview: { proxy } })
