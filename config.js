// API keys are read from environment variables so they are never stored in the
// project. Set them before launching, for example:
//   GEMINI_API_KEY=... EXA_API_KEY=... npm start
const API_CONFIG = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    EXA_API_KEY: process.env.EXA_API_KEY || ''
};

module.exports = API_CONFIG;
