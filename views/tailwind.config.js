module.exports = {
  content: [
    './views/**/*.ejs'
  ],
  theme: {
    extend: {
      colors: {
        cyan: {
          600: '#00b7eb',
          700: '#0099cc'
        },
        red: {
          600: '#e53e3e',
          700: '#c53030'
        },
        green: {
          600: '#34d399', // Tailwind's default green-600
          700: '#10b981'  // Tailwind's default green-700
        },
        purple: {
          600: '#a78bfa', // Tailwind's default purple-600
          700: '#8b5cf6'  // Tailwind's default purple-700
        }
      }
    }
  },
  plugins: []
};