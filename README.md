# mmods

A marketplace of Claude Code mods.

## Add the marketplace

```
claude plugin marketplace add zhengjie919/mmods
```

## Install a mod

```
claude plugin install <mod>@mmods
```

## Mods

| Mod | What it does |
|---|---|
| `toolbox` | Pane with cache keep-warm pings, context, time, cost, model and effort switchers, handoff, and a simple conversation view. Install: `claude plugin install toolbox@mmods` |
| `second-brain` | Auto-captures durable knowledge from Claude sessions (and delegated opencode work) into an Obsidian wiki with a background Haiku agent. Pane with capture state and recent saves. Install: `claude plugin install second-brain@mmods` |

## Layout

Each mod lives under `plugins/`:

```
plugins/<mod>/.claude-plugin/plugin.json
plugins/<mod>/hooks/hooks.json
```

## Developing a mod

Use one working copy, `~/mmods`, for both testing and GitHub. Two copies that both commit split the history.

Set it up once: make the working copy your `mmods` marketplace, so sessions read each mod from its folder.

```
claude plugin marketplace remove mmods
claude plugin marketplace add ~/mmods
claude plugin install second-brain@mmods --scope user
claude plugin install toolbox@mmods --scope user
```

`claude plugin list` then shows `Read from: ~/mmods/plugins/<mod>`.

Each change:

1. Run `git pull` in `~/mmods` before you edit.
2. Edit the mod in `~/mmods/plugins/<mod>`.
3. Run `claude plugin validate plugins/<mod>` and `claude plugin test plugins/<mod>`.
4. Run `/reload-plugins` to try the change in a live session. You do not need a new version or a reinstall.
5. Bump `version` in `plugins/<mod>/.claude-plugin/plugin.json`, commit, and push at once.

Rules:

- Do not edit files under `~/.claude/plugins/cache/` or `~/.claude/plugins/marketplaces/`. Those are installed copies.
- Do not commit from any clone other than `~/mmods`.
- Do not leave commits unpushed. Another session works from GitHub and does not see them.
- Other machines and other people get a change from GitHub through `claude plugin update <mod>@mmods` and then `/reload-plugins`.
