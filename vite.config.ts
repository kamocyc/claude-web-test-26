import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: { host: '127.0.0.1', port: 5173 },
})
