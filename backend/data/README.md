# Genre summary suggestions

**File:** `summaries_by_genre.json`

This file drives the "Suggestions for this genre" feature on the frontend. Each key is a genre name; each value is an array of summary strings (reusable loglines).

## Format

```json
{
  "Romance": ["summary one...", "summary two..."],
  "Drama": ["..."],
  "Action": ["..."],
  "Adventure": ["..."],
  "Crime": ["..."],
  "Horror": ["..."],
  "Fantasy": ["..."],
  "Monster": ["..."],
  "Science Fiction": ["..."],
  "Superhero": ["..."]
}
```

- **Genre keys** must match the frontend dropdown exactly: Romance, Drama, Action, Adventure, Crime, Horror, Fantasy, Monster, Science Fiction, Superhero.
- **Values** are arrays of strings. Add up to 100 (or more) per genre. Each string is one suggested summary; the user can click "Generate one" (random) or "Load list" and pick from the dropdown.

## Adding your 100 summaries per genre

1. Open `summaries_by_genre.json`.
2. For each genre, set the value to an array of summary strings, e.g.:
   ```json
   "WEREWOLF": [
     "A lone she-wolf is forced to choose between her pack and the human who saved her life.",
     "..."
   ]
   ```
3. Save the file. The backend reads it on each request; no restart needed (unless the server caches the file—currently it does not).
