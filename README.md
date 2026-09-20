# symflow-mcp — Claude MCP for TikTok Symphony Creative Studio

Run TikTok's **Symphony Creative Studio** from Claude Code or Claude Desktop: trend templates with
their full director prompts, reference-to-video / image-to-video / text-to-video on Seedance,
talking avatars, product and apparel try-on, video refresh from your own footage, dubbing into other
languages and the editor draft — inside **your own** Symphony account and weekly credits.

This package is the open bridge: an MCP server (stdio) plus a tiny local HTTP queue. The work in the
browser is done by the **SymFlow Chrome extension** (https://lingoflow.pro/symflow), which reads the
studio's data with your session and reports results back. No API keys, no scraping services, nothing
leaves your machine except the calls your browser already makes to ads.tiktok.com.

```
Claude ──MCP stdio──▶ symflow-mcp ──▶ bridge 127.0.0.1:8789 ◀── polling ── SymFlow extension ──▶ Creative Studio tab
                                            │
                                     files on disk (symflow-out/<job>/)
```

## Install

```bash
claude mcp add symflow -- npx -y symflow-mcp
```

Then install the SymFlow extension, open `ads.tiktok.com/creative/creativestudio` signed in, and ask
Claude to call `sym_status`. Claude receives the director playbook from the extension and works by it:
asks what you sell and where, proposes ideas, names the cost in credits before spending, generates,
waits and downloads the files.

## Tools

| Tool | What it does |
|---|---|
| `sym_status` | connection, credits (weekly grant, spent, next refill), available models, inbox from the "→ Claude" button, the director playbook |
| `sym_templates`, `sym_template` | TikTok trend templates with the complete director prompt, reference image and sample video |
| `sym_generate` | reference-to-video, image-to-video, text-to-video, image generation; `dryRun` returns the price first |
| `sym_avatars`, `sym_voices`, `sym_avatar_video` | AI and real avatars, voices, a talking avatar video from a script with captions |
| `sym_tryon` | avatar holding your product or wearing your apparel (images, then animated clips) |
| `sym_transform` | "Video refresh": new 15/30 s TikTok cuts from your ≥15 s footage and photos, 11 languages |
| `sym_dub` | dubbing into other languages, subtitle replacement, lip-sync |
| `sym_editor` | read / update / render / export the server-side editor draft |
| `sym_history`, `sym_links`, `sym_upload`, `sym_credits` | what was generated, download links, library uploads, ledger |
| `sym_wait`, `sym_cancel`, `sym_log` | wait for files, cancel the queue, diagnostics |

## Credits

Symphony grants weekly credits. Only Seedance clips are charged (Seedance 1.5: 1 credit per second;
2.0: 5; 2.0 Mini: 2; 2.0 Fast: 3; 2.5: 10). Image generation, talking avatars, try-on images, video
refresh and dubbing were free at the time of writing. Claude reads the balance before every batch and
stops when a job would exceed it.

## Remote Claude

By default the bridge listens on `127.0.0.1:8789`. For Claude on another machine set `OF_HOST` to a
Tailscale address; a non-loopback bind requires the token from `~/.symflow-token` (header
`X-SymFlow-Token`), which you paste into the extension settings.

## Security

The bridge refuses requests with an `http(s)` Origin (only `chrome-extension://` and local callers),
keeps its queue in memory, and never stores your TikTok session — the extension uses the cookies your
browser already has. The Symphony adapter and the director playbook are part of the extension, not of
this package.

MIT © DanikVR — https://lingoflow.pro/symflow
