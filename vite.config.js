import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        content: 'src/content.ts',
        background: 'src/background.ts',
        options: 'src/options.js'
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]'
      }
    },
    outDir: 'dist',
    emptyOutDir: true,
    // 静的ファイルのコピー
    copyPublicDir: false
  },
  // 静的ファイルを手動でコピーするためのプラグイン
  plugins: [
    {
      name: 'copy-static-files',
      writeBundle() {
        // 静的ファイルをコピー
        const fs = require('fs');
        const path = require('path');
        
        // manifest.json をコピー
        fs.copyFileSync('src/manifest.json', 'dist/manifest.json');
        
        // options.html をコピー
        fs.copyFileSync('src/options.html', 'dist/options.html');
        
        // styles.css をコピー
        fs.copyFileSync('src/styles.css', 'dist/styles.css');
      }
    }
  ],
  define: {
    'process.env.NODE_ENV': '"production"'
  }
})