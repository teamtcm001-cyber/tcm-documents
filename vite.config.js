import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    // the git-ignored local test harness writes / locks big files: never watch it (a locked file crashed the dev server)
    watch: { ignored: ['**/.tests-local/**', '**/poster-output/**'] }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
