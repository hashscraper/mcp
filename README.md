# HashScraper MCP

Collect public web data from your AI agent. Ask "Summarize today's prices of the Coupang top 30 for 커피믹스" and the **HashScraper MCP server** fetches the daily best-seller ranking of the category — with price, reviews, delivery and detail-page columns — or runs one of 120+ ready-made data bots (Naver blog/cafe/news/shopping, Instagram, YouTube, Olive Young, Musinsa, Kurly, KREAM, Google/Kakao maps, app stores, community boards …).

- No scraper code and no browser on your side. Node.js 20+ and one line of config.
- Every account gets **free credits every day** (refill at midnight KST). The server uses only the daily free credits unless you tell it to use your own.
- Your API key is saved on your computer only (`~/.config/hashscraper/credentials`, readable only by you) and is never shown to the agent.

Homepage: https://www.hashscraper.com/mcp?utm_source=mcp&utm_medium=github&utm_campaign=mcp_repo

## Install

The server runs locally over stdio: `npx -y @hashscraper/mcp`.

### Claude Code

```bash
claude mcp add hashscraper -- npx -y @hashscraper/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "hashscraper": {
      "command": "npx",
      "args": ["-y", "@hashscraper/mcp"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hashscraper": {
      "command": "npx",
      "args": ["-y", "@hashscraper/mcp"]
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.hashscraper]
command = "npx"
args = ["-y", "@hashscraper/mcp"]
```

### MCP Bundle (.mcpb)

To build a one-file bundle for apps that install `.mcpb` files (it includes the server and its dependencies, and asks for the optional API key):

```bash
npm install && npm run pack:mcpb   # -> server.mcpb
```

## Connect once

Ask your agent to "connect HashScraper" (or just ask for some data). It calls the `login` tool, which returns a link and an 8-character code. Open the link, sign in (or sign up for free with Google or email), check that the code matches, and click **Approve and connect**. Then tell the agent you approved — it calls `login` again and the key is saved. You never copy or paste the key.

Prefer your own key? Create one in **My page → API** and set `HASHSCRAPER_API_KEY` in the server's environment. It is used before the saved key.

## Try these prompts

1. "Summarize today's prices of the Coupang top 30 for 커피믹스."
2. "Which Coupang categories can you rank? Compare the top 5 of 에센스 by price."
3. "Collect 50 Naver blog posts about 성수동 카페 and save them as a CSV."
4. "What is the price of this Coupang product right now? https://www.coupang.com/vp/products/…"
5. "How many free credits do I have left today?"

## Tools

| Tool | What it does | Credits |
|---|---|---|
| `login` | Connect your HashScraper account in the browser (two calls: link, then finish) | free |
| `me` | Account email and today's free credits | free |
| `catalog` | Search the built-in list of 120+ bots and their inputs | free |
| `run` | Collect with one bot and return the rows (waits up to 55 s, then gives a dataset id) | per row, see `catalog` |
| `fetch` | Get the rows of an earlier `run` by dataset id | free |
| `coupang_categories` | Coupang categories with a ready daily top 30 | free |
| `coupang_top` | Top 30 of a Coupang category with detail columns (collected once a day) | 300 per category per snapshot; fetching the same snapshot again is free |

Large results can be saved to a file with `csv_path` (an absolute path ending in `.csv`, UTF-8 with BOM so Excel reads Korean).

## Free credits

- Free credits refill every day at midnight (KST). Unused credits do not carry over.
- When today's free credits run out, the tool stops and tells you when they refill. Your own credits are used only when you ask (`use_credits`).

## Data terms

The data is for your internal analysis only — no resale or redistribution: https://www.hashscraper.com/data-terms

Before the first command that uses credits, the server stops and shows the terms. Your agent must show them to you and may continue only after you clearly agree (`accept_terms`). It is asked once per account. The agent never agrees for you.

## Privacy

The server collects public pages only and never asks for a site login. It talks only to the HashScraper API (`https://www.hashscraper.com/v5/api`). The saved key lives in `~/.config/hashscraper/credentials` (owner-only) and is shared with the HashScraper Agent Skill. Delete the file to disconnect, or turn the key off in **My page → API & integrations**.

## Need something else?

Missing site or Coupang category, daily scheduled collection, or large volumes? Email help@hashscraper.com with the site, the data you need, how much and how often — or talk to us: https://www.hashscraper.com/quotes/new?utm_source=mcp&utm_medium=github&utm_campaign=mcp_repo

## License

MIT. See [LICENSE](LICENSE).
