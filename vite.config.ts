import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// base './' keeps asset URLs relative so the build works when served from a
// GitHub Pages project subpath (BoseSean.github.io/niz-web-programmer/).
export default defineConfig({
  base: './',
  plugins: [react()],
})
