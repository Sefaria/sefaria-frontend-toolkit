---
"@sefaria/api-client": minor
---

Add `lexicon.getLexiconEntry` and its generated request, response, and status-specific validators from Sefaria OpenAPI commit `26503349c8c5d54567fb53c52619ebcca225c484`. Preserve the optional wrapper fields and arbitrary nested raw entry data. Generate inline HTTP error validators without changing upstream transport declarations or combining incompatible status schemas.
