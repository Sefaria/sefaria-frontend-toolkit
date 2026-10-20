import { SefariaReader } from "@sefaria/web-components";
import type { SefariaDataLoader } from "@sefaria/web-components";

const localTextPaths = new Map([
  ["Micah 6:8", "/data/micah-6-8.json"],
  ["Micah 6", "/data/micah-6.json"],
]);

const loader: SefariaDataLoader = {
  getText: async ({ sref }, signal) => {
    const path = localTextPaths.get(sref);
    if (path === undefined) {
      throw new Error(`No local text for ${sref}.`);
    }
    const response = await fetch(path, { signal });
    return { payload: await response.json(), status: response.status };
  },
  getLinks: async ({ sref }) => {
    if (!localTextPaths.has(sref)) {
      throw new Error(`No local links for ${sref}.`);
    }
    return { payload: [], status: 200 };
  },
};

const reader = document.querySelector("sefaria-reader");
if (reader instanceof SefariaReader) {
  reader.source = { kind: "custom", loader };
  reader.sref = "Micah 6:8";
}
