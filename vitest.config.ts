import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.ts'],fileParallelism:false,testTimeout:30000,hookTimeout:90000,pool:'forks',maxWorkers:1,minWorkers:1}});
