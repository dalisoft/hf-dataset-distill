import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL!
  },

  schema: './src/db/schemas/index.ts',
  out: './drizzle',

  migrations: {
    table: 'journal',
    schema: 'drizzle'
  },

  strict: true,
  verbose: true
});
