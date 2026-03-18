# Fix: Preserve Hidden Visibility When Merging Symbols and Localize dynsym Exports

## Issue #1693

When Wild links a shared library (`-shared`), some symbols were incorrectly appearing in the
dynamic symbol table (`dynsym`) even though ELF visibility rules say they must stay local.

---

## ELF Visibility Rules (Background)

Every ELF symbol has a visibility field (`st_other`):

| Visibility | Meaning |
|---|---|
| `STV_DEFAULT` | Exported, interposable — can appear in dynsym |
| `STV_PROTECTED` | Exported, non-interposable — can appear in dynsym |
| `STV_HIDDEN` | **Never exported** — must NOT appear in dynsym |

When two object files both define or reference the same symbol with different visibilities,
the linker must merge them using **most restrictive wins**:
```
hidden > protected > default
```

---

## The Bug — Two Cases

### Case 1: Visibility merging across definitions

```c
// File A: visibility-merging.c
int data1 __attribute__((weak)) = 0x42;           // default visibility

// File B: visibility-merging-1.c
int data1 __attribute__((weak, visibility("hidden"))) = 0x100;  // hidden
```

Since one definition is hidden, the merged result must be hidden → `data1` must NOT be in dynsym.
Wild was computing the merged visibility correctly but **silently discarding it**, so `data1`
(and `data4`) leaked into dynsym as global symbols.

### Case 2: Hidden undefined reference

```c
// File A: visibility-merging.c
extern int data5 __attribute__((visibility("hidden")));  // undefined, hidden
int get_data5(void) { return data5; }

// File B: visibility-merging-1.c
int data5 = 0x101;  // defined, default visibility
```

File A treats `data5` as hidden — it must not be interposable and must not be exported.
Since one object references it as hidden and the other defines it with default visibility,
they **never appear together as alternative definitions** — so the visibility merge path
never ran for this case. Wild exported `data5` into dynsym incorrectly.

---

## Wild's Symbol Pipeline (5 Phases)

Understanding the pipeline is key to understanding the fix.

### Phase 1: `read_symbols` (parallel per file group)

Each object file is processed in parallel by a thread. For every symbol:
- **Defined global** → added to `pending_symbols_by_bucket[name.hash() % N].symbols`
- **Undefined** → NOT added to pending symbols; `symbol_definitions[id] = SymbolId::undefined()`
- **Local** → assigned a SymbolId, stored only in `symbol_file_ids`

Output: `SymbolLoadOutputs` per file group, with pending symbols sorted by hash bucket.

### Phase 2: `populate_symbol_db` (parallel per bucket)

For each of N buckets (parallel), merges all per-file pending symbols into the shared
`SymbolBucket`:
- Builds `bucket.name_to_id`: symbol name → first SymbolId seen with that name
- Builds `bucket.alternative_definitions`: first SymbolId → all later SymbolIds with the
  same name (for weak symbol resolution)

After this phase: `name_to_id["data5"] = 99`, `name_to_id["data1"] = 7`.

### Phase 3: `resolve_alternative_symbol_definitions` (parallel per bucket)

For each bucket, calls `process_alternatives`:
- Iterates all symbols with multiple definitions
- Computes merged visibility across all alternatives
- Picks the "best" definition (strong > weak, larger common, etc.)
- Updates `symbol_definitions[alt] = selected` for all alternatives
- **Applies `handle_non_default_visibility`** if merged visibility is non-default

This is where `data1` and `data4` (Case 1) are now correctly handled.

### Phase 4: `resolve_symbols_and_select_archive_entries` + `canonicalise_undefined_symbols`

This is where undefined symbol references are resolved to their definitions.
`canonicalise_undefined_symbols` iterates all undefined symbols collected during resolution:
- Does a name lookup (`name_to_id.entry(name)`) to find the definition
- In the `Occupied` case: connects the undefined symbol to the definition via
  `symbol_db.replace_definition(undefined.symbol_id, definition_id)`
- This is where `data5` (Case 2) is now handled — see Fix 3 below

### Phase 5: Layout + ELF writing

`layout.rs` reads `ValueFlags::DOWNGRADE_TO_LOCAL` to decide if a symbol is local.
`elf_writer.rs` uses the same flag to set `STB_LOCAL` binding in the output symbol table.
Local symbols are never placed in dynsym.

---

## What `symbol_definitions` and `name_to_id` Store

**`symbol_definitions`** — a flat array indexed by SymbolId:
```
symbol_definitions[7]  = 7    // data1 winner points to itself
symbol_definitions[42] = SymbolId::undefined()  // undefined data5 in file A → dead end
symbol_definitions[99] = 99   // data5 definition in file B points to itself
```

**`name_to_id`** — per-bucket hashmap from name → SymbolId:
```
name_to_id["data5"] = 99   // only defined symbols are stored here
name_to_id["data1"] = 7
```

**Key insight for Case 2:** When we encounter the hidden undefined `data5` (ID=42) in file A,
`symbol_definitions[42] = SymbolId::undefined()` — a dead end. We cannot follow the chain
from ID=42 to reach the definition ID=99. We can only find ID=99 via `name_to_id["data5"]`.

---

## The Fix — All Changes

### Fix 1: `handle_non_default_visibility` function (new, `symbol_db.rs`)

```rust
fn handle_non_default_visibility(
    per_symbol_flags: &AtomicPerSymbolFlags,
    symbol_id: SymbolId,
    visibility: Visibility,
) {
    let flags = per_symbol_flags.get_atomic(symbol_id);
    match visibility {
        Visibility::Hidden => {
            flags.or_assign(ValueFlags::NON_INTERPOSABLE | ValueFlags::DOWNGRADE_TO_LOCAL);
        }
        Visibility::Protected => {
            if !flags.get().contains(ValueFlags::DYNAMIC) {
                flags.or_assign(ValueFlags::NON_INTERPOSABLE);
            }
        }
        Visibility::Default => {}
    }
}
```

**What it does:** Applies the correct `ValueFlags` based on merged visibility.

- `Hidden` → sets `NON_INTERPOSABLE` (direct references allowed, no GOT needed) AND
  `DOWNGRADE_TO_LOCAL` (the critical flag — prevents the symbol from being placed in dynsym,
  causes `STB_LOCAL` binding in elf_writer).
- `Protected` → sets `NON_INTERPOSABLE` only (symbol stays in dynsym but is non-interposable).
  Skip for dynamic symbols since they handle this at runtime.
- `Default` → no change.

**Why `DOWNGRADE_TO_LOCAL` specifically:** This flag is checked at multiple points during
layout and ELF writing. When set, the symbol is treated as local in all output decisions —
it will not be placed into the dynamic symbol table.

**Why two separate functions (`handle_non_default_visibility` and `apply_visibility_to_definition`):**
- `handle_non_default_visibility` is used during Phase 3 (`resolve_alternative_symbol_definitions`)
  which runs in parallel and uses `AtomicPerSymbolFlags` for thread-safe flag updates.
- `apply_visibility_to_definition` is used during Phase 4 (`canonicalise_undefined_symbols`)
  which runs sequentially and uses plain `&mut PerSymbolFlags`.
  The logic is identical, only the type differs.

---

### Fix 2: Call `handle_non_default_visibility` inside `process_alternatives` (`symbol_db.rs`)

```rust
// Inside process_alternatives, after selecting the winner:
if visibility != Visibility::Default {
    handle_non_default_visibility(per_symbol_flags, first, visibility);
    for alt in alternatives {
        handle_non_default_visibility(per_symbol_flags, alt, visibility);
    }
}
```

**What it does:** After `process_alternatives` picks the winning definition and computes
the merged visibility, it now actually applies that visibility to the flags. Before this
fix, the merged visibility was computed but thrown away.

**Why `first` AND all `alternatives` get updated:** Both the `first` SymbolId (the one in
`name_to_id`) and all the `alternatives` point to the same winner via `symbol_definitions`.
But `ValueFlags` are stored per-SymbolId, not per-definition. All entries need the flags
so that any code that looks up flags by a non-canonical ID still sees them correctly.

This fixes **Case 1** (`data1`, `data3`, `data4`).

---

### Fix 3: `apply_visibility_to_definition` function (new, `symbol_db.rs`)

```rust
pub(crate) fn apply_visibility_to_definition(
    per_symbol_flags: &mut PerSymbolFlags,
    definition_id: SymbolId,
    visibility: Visibility,
) {
    match visibility {
        Visibility::Hidden => {
            per_symbol_flags.set_flag(
                definition_id,
                ValueFlags::NON_INTERPOSABLE | ValueFlags::DOWNGRADE_TO_LOCAL,
            );
        }
        Visibility::Protected => {
            if !per_symbol_flags
                .flags_for_symbol(definition_id)
                .contains(ValueFlags::DYNAMIC)
            {
                per_symbol_flags.set_flag(definition_id, ValueFlags::NON_INTERPOSABLE);
            }
        }
        Visibility::Default => {}
    }
}
```

**What it does:** Same logic as `handle_non_default_visibility` but uses `&mut PerSymbolFlags`
(non-atomic) because it is called from sequential code in Phase 4.

---

### Fix 4: Call `apply_visibility_to_definition` in `canonicalise_undefined_symbols` (`resolution.rs`)

```rust
// Inside canonicalise_undefined_symbols, Occupied case:
hashbrown::hash_map::Entry::Occupied(entry) => {
    let definition_id = symbol_db.definition(*entry.get());
    symbol_db.replace_definition(undefined.symbol_id, definition_id);
    // NEW: apply visibility from the undefined reference to the definition
    let visibility = symbol_db.input_symbol_visibility(undefined.symbol_id);
    symbol_db::apply_visibility_to_definition(per_symbol_flags, definition_id, visibility);
}
```

**What it does:** When `canonicalise_undefined_symbols` resolves an undefined symbol to its
definition (the `Occupied` case — definition already known in `name_to_id`), we now:
1. Get the canonical definition ID via `symbol_db.definition(*entry.get())` — follows the
   two-step chain to get the winner (not just the first-seen ID)
2. Check the visibility of the undefined reference itself via
   `symbol_db.input_symbol_visibility(undefined.symbol_id)` — this reads the original ELF
   `st_other` field of the undefined symbol, which carries the hidden annotation
3. If hidden → apply `DOWNGRADE_TO_LOCAL` to the definition

**Why this is the right place:** `canonicalise_undefined_symbols` already does a name lookup
for every undefined symbol — the `name_to_id.entry(name)` call. We piggyback on that lookup
to check visibility and set flags at the same time. No extra iterations, no extra data
structures, no extra hash lookups.

**Why not store names or IDs separately:** The undefined symbol has
`symbol_definitions[id] = SymbolId::undefined()` — a dead end. Its SymbolId cannot be used
to find the definition. The name is needed to look up the definition, but since
`canonicalise_undefined_symbols` already does that name lookup, we don't need to store
anything extra. The visibility information is already on the undefined symbol's SymbolId
via `input_symbol_visibility`.

This fixes **Case 2** (`data5`).

---

## Changes to Test File (`wild/tests/sources/visibility-merging.c`)

Removed 4 lines that were suppressing known-bad diffs with BFD:

```c
// TODO: Prevent dynsym export of symbols like these.
//#DiffIgnore:dynsym.data1.*
//#DiffIgnore:dynsym.data4.*
//#DiffIgnore:dynsym.data5.*
```

With the fix, Wild now correctly excludes `data1`, `data4`, and `data5` from dynsym,
matching BFD's output exactly for these symbols.

---

## Before vs After: dynsym

| Symbol | Before (Wild) | After (Wild) | BFD (correct) |
|--------|---------------|--------------|---------------|
| data1 | GLOBAL DEFAULT ❌ | not in dynsym ✅ | not in dynsym |
| data2 | GLOBAL DEFAULT ✅ | GLOBAL DEFAULT ✅ | GLOBAL DEFAULT |
| data3 | GLOBAL DEFAULT | GLOBAL DEFAULT | GLOBAL PROTECTED |
| data4 | GLOBAL DEFAULT ❌ | not in dynsym ✅ | not in dynsym |
| data5 | GLOBAL DEFAULT ❌ | not in dynsym ✅ | not in dynsym |
| get_data1 | GLOBAL DEFAULT ✅ | GLOBAL DEFAULT ✅ | GLOBAL DEFAULT |
| get_data5 | GLOBAL DEFAULT ✅ | GLOBAL DEFAULT ✅ | GLOBAL DEFAULT |

> **Known gap:** `data3` shows `DEFAULT` Vis in Wild's dynsym but `PROTECTED` in BFD.
> This is a pre-existing issue with how Wild propagates `PROTECTED` visibility to the Vis
> field in the ELF output. It is not introduced by this fix and is being tracked separately.

---

## Evolution of the Fix

### Version 1 (original, had 8% perf regression)
Stored all hidden undefined names in a flat `Vec` on `SymbolDb`. After the parallel
`resolve_alternative_symbol_definitions`, iterated the entire Vec sequentially on the main
thread and did a name lookup for each. This added a sequential pass proportional to the
number of hidden undefined references.

### Version 2 (per-bucket, parallel)
Moved `hidden_undefined_names` from a flat Vec to per-bucket storage in `SymbolBucket`.
Processed them inside the existing `buckets.par_iter_mut()` loop — fully parallel.
Used `bucket.name_to_id.get(name)` directly (safe because names are routed to the same
bucket as their definitions by the same hash function).

### Version 3 (final, zero storage)
Removed `hidden_undefined_names` entirely. Instead, piggybacks on the existing name lookup
in `canonicalise_undefined_symbols` (Phase 4). When the definition is found for an undefined
symbol, immediately checks if the reference was hidden and applies `DOWNGRADE_TO_LOCAL` to
the definition. Zero extra data structures, zero extra iterations, zero extra hash lookups.
This is what the maintainer suggested: "update the flags during the resolution phase —
i.e. when we resolve undefined symbols."

---

## Files Changed

| File | Changes |
|------|---------|
| `libwild/src/symbol_db.rs` | Added `handle_non_default_visibility`, called it in `process_alternatives`, added `apply_visibility_to_definition` (public) |
| `libwild/src/resolution.rs` | In `canonicalise_undefined_symbols` Occupied case: call `apply_visibility_to_definition` with the definition's visibility |
| `wild/tests/sources/visibility-merging.c` | Removed 4 `#DiffIgnore` lines for `data1`, `data4`, `data5` |
