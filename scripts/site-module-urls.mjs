import {
  PACKAGE_DEFINITIONS,
  releaseVersionSchema,
} from "./package-publication.mjs";

export function packageBrowserUrls(version, candidate, basePath = "/") {
  releaseVersionSchema.parse(version);
  return Object.fromEntries(
    PACKAGE_DEFINITIONS.map((definition) => [
      definition.name,
      candidate
        ? `${basePath}cdn/local/${definition.browserFile}`
        : `https://cdn.jsdelivr.net/npm/${definition.name}@${version}/dist/browser/${definition.browserFile}`,
    ]),
  );
}

export function moduleUrls(
  version,
  basePath = "/",
  documentedVersion = version,
) {
  if (version !== null) releaseVersionSchema.parse(version);
  return Object.fromEntries(
    PACKAGE_DEFINITIONS.flatMap((definition) => {
      const destination =
        version === null
          ? `${basePath}cdn/local/${definition.browserFile}`
          : `https://cdn.jsdelivr.net/npm/${definition.name}@${version}/dist/browser/${definition.browserFile}`;
      return [
        [
          `https://sefaria.github.io/sefaria-frontend-toolkit/cdn/alpha/${definition.browserFile}`,
          destination,
        ],
        ...(documentedVersion
          ? [
              [
                `https://cdn.jsdelivr.net/npm/${definition.name}@${documentedVersion}/dist/browser/${definition.browserFile}`,
                destination,
              ],
            ]
          : []),
      ];
    }),
  );
}

export function rewriteModuleUrls(
  text,
  version,
  basePath = "/",
  documentedVersion = version,
) {
  for (const [before, after] of Object.entries(
    moduleUrls(version, basePath, documentedVersion),
  ))
    text = text.replaceAll(before, after);
  return text;
}

export function siteModuleUrlsPlugin({
  version,
  candidate,
  basePath,
  documentedVersion,
}) {
  return {
    name: "sefaria-site-module-urls",
    enforce: "post",
    transform(code, id) {
      if ((!version && !candidate) || !/\.(?:vue|md|html)(?:\?|$)/u.test(id))
        return;
      return rewriteModuleUrls(
        code,
        version || null,
        basePath,
        documentedVersion,
      );
    },
  };
}
