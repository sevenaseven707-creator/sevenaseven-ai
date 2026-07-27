# SevenaSeven AI Bot (Enterprise Grade 10/10)

High-performance Telegram AI Bot built on Cloudflare Workers, Google Gemini 2.5 Flash, Cloudflare KV Memory, and Vision API.

---

## 1. Cloudflare KV Setup
Create a KV Namespace for Memory & Rate Limits:

```bash
npx wrangler kv:namespace create BOT_KV

