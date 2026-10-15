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

## Layout

Each mod lives under `plugins/`:

```
plugins/<mod>/.claude-plugin/plugin.json
plugins/<mod>/hooks/hooks.json
```
