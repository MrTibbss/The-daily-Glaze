import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      // Map the `pink` palette to Tailwind's `cyan` palette so existing
      // `pink-*` classes render as cyan without changing every source file.
      colors: {
        pink: colors.cyan,
      },
    },
  },
};

export default config;
