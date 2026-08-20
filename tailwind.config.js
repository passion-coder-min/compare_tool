/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bc: {
          // Beyond Compare 风格的差异高亮色
          del: "#ffd7d5",
          ins: "#d1f8d3",
          delchar: "#ff9d9b",
          inschar: "#7ce984",
        },
      },
    },
  },
  plugins: [],
};
