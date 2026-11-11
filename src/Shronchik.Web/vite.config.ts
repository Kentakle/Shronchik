import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  worker: { rollupOptions: { output: { entryFileNames: 'assets/workers/[name]-[hash].js' } } },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:5271', changeOrigin: false } },
  },
  build: { outDir: '../Shronchik.Server/wwwroot', emptyOutDir: true },
});
