import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径：方便部署到任意子目录（EdgeOne Pages / 对象存储都能直接用）
  base: './',
  build: {
    // 默认目标是 Chrome111/Safari16.4+，老人旧机跑不动。降到 es2015。
    target: 'es2015',
    // 微信内置浏览器不支持 #RGBA 等新语法，降级到 chrome61
    cssTarget: 'chrome61',
    outDir: 'dist',
    rollupOptions: {
      // 多页：首页可被索引，结果页写死 noindex，自检页与 404 也不进索引
      input: {
        main: 'index.html',
        result: 'r.html',
        evidence: 'e.html',
        selftest: 'selftest.html',
        notfound: '404.html',
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
