export const browserModuleUrls: Readonly<
  Record<
    | "@sefaria/api-client"
    | "@sefaria/text-transform"
    | "@sefaria/web-components",
    string
  >
> = import.meta.env.SEFARIA_BROWSER_MODULE_URLS;
