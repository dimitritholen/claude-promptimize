# claude-promptimize

`/promptimize` for Claude Code: a pane where you type a rough prompt, pick a size and get an optimized prompt back, after a short interview when the prompt leaves real gaps. The result lands in the prompt box, unsent, so you can edit it before you press Enter.

This is a port of the pi extension [pi-promptimize](https://github.com/dimitritholen/pi-promptimize). It is a Claude Code plugin with a hooks module (a "mod") and needs Claude Code 2.1.332 or newer. The mod API is early access and can change between releases.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install promptimize --marketplace dimitritholen/claude-promptimize
```

Or from a shell:

```bash
claude plugin install promptimize --marketplace dimitritholen/claude-promptimize
```

Answer `y` to add the marketplace, then pick a scope. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dimitritholen/claude-promptimize`, then Add plugin.

To work on it, clone the repository and load it from its folder:

```bash
claude --plugin-dir path/to/claude-promptimize
```

## Use

Open the pane with `/promptimize [text]`.

If another command or skill already holds the name `/promptimize`, the pane registers as `/promptimize-pane` instead.

1. **Compose.** Pick the model that writes the prompt and who the prompt is written for (this session, or a Claude, GPT, Gemini or image model used elsewhere), type the rough prompt, choose a size and, if the prompt refers to the conversation ("fix that", "the same for X"), tick *Include recent session context*. Enter in the prompt field or the Generate button starts.
   - **Small:** terse, 1 to 6 lines.
   - **Medium:** compact Markdown sections, about 100 to 250 words.
   - **Large:** a complete prompt of about 300 to 700 words with role, approach, constraints, a self-check and an output contract.

   The size sets how much is added. A rough prompt that is already long may grow beyond these ranges; a result over the limit is shortened once.
2. **Interview.** When the prompt leaves decisions open that only you can make and that change the result, the model asks questions first, each with a suggested default. A clear prompt gets none. Budget: small 2 questions in 1 round, medium 3 in up to 2 rounds, large 4 in up to 3 rounds. Enter answers; an empty Enter takes the default; `-` skips; *Use defaults and generate* takes the defaults for the rest.
3. **Review.** The pane shows the result, and above it what the model thinks you are after. If that reading is off, type what you are after in the field under it and press Enter: the prompt is written again from your words. *Use* puts it in the prompt box; `r` regenerates; `1`, `2`, `3` switch size (keeps your answers); `e` goes back to edit the rough prompt; `c` copies the result.

The model first works out the goal behind your words, then writes a new prompt from that goal instead of rearranging your text. Vague requirements ("polished", "complete") get a minimum bar the target can check; matters of taste ("original") get a working method. The prompt is written for the target you picked: by default a coding agent working in the current directory. What the agent can look up becomes an instruction to look it up; only what you alone know and the result cannot do without becomes an `[INSERT X]` placeholder.

Keys: Tab and the arrow keys move between the controls, Enter presses the focused one, Esc closes the pane and cancels a running request. While the model works, the Cancel button stops the request and keeps the pane open. The pane remembers your model, size, context choice and unfinished prompt for the session.

If the prompt box cannot take the text, the result goes to the clipboard and a toast says so.

### A shortcut

A mod cannot register a keyboard shortcut. According to the Claude Code keybindings docs, a key can run a slash command with the action `command:<name>`; this is not tested here. In `~/.claude/keybindings.json`:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+x p": "command:promptimize" } }
  ]
}
```

`alt+p`, the shortcut of the pi version, is Claude Code's model picker.

## Settings

The plugin's options, in `/config` or under `pluginConfigs` in `~/.claude/settings.json`:

- `model`: the model the pane starts with, an alias (`opus`, `sonnet`, `haiku`) or a full model id. Default: the `model` in your settings, else `sonnet`. A model you pick in the pane wins for the rest of the session.
- `models`: extra model ids for the picker, separated by commas.
- `includeContext`: the default of the context box. Default `false`; it costs tokens.

The interview call runs at low effort; the rewrite runs at the model's own effort. Model calls are billed to your session.

## Differences from the pi version

| pi | Claude Code |
|---|---|
| Centered popup | A pane, docked beside the transcript or inline above the prompt |
| Model list with a fuzzy filter, all providers | A picker over your configured models and the aliases |
| Starts with the session's model | Starts with the `model` option, else the `model` setting, else `sonnet` |
| `alt+p` | Your own keybinding, see above |
| Tab takes the defaults in the interview | A button; Tab moves the focus |
| Esc cancels a running request, a second Esc closes | Esc closes and cancels; the Cancel button only cancels |
| `r`, `e`, `1-3` and ←/→ in the review | `r`, `e`, `c`, `1-3` as hotkeys while the pane has focus |
| The session's thinking level, retried without it on failure | Fixed effort per call; the engine drops it for models without effort |

## Test

```bash
npm test             # claude plugin test: unit and pane tests, no model calls
npm run validate     # claude plugin validate
npm run eval         # real model: 10 rough prompts × 3 sizes, checked automatically
```

The eval answers interview questions with their defaults and checks per output: that it is a prompt and not the task's result (a judge call), language, length per size, number of placeholders, verbatim details, sentence length in the lists, and a number of interview questions within the range the case allows. Options: `--model id`, `--sizes small,medium`, `--cases id,id`, `--concurrency n`, `--runs n` (repeat each case and show how many runs passed), `--set dev|holdout|all` (the holdout cases are not used for tuning the prompts).

For cases marked `substance` a judge call counts how many of the rough prompt's vague requirements the output makes checkable. To check that judge against your own opinion: `node eval/run.ts --labels` writes `eval/labels.json`; set each `human` to `true` or `false`; `node eval/run.ts --check-judge` then reports how often the judge agrees. Full outputs go to `eval/out/` (git-ignored).

The eval calls the model through `claude -p`, so it uses your Claude Code sign-in and counts toward its usage. A full run makes about 90 model calls. It tests the prompts, not the pane: the pane calls the model through the mod API.

Type-check with the declarations Claude Code lays in `.claude-plugin/types/` once it has loaded the mod from this folder: `npx -p typescript tsc -p .`
