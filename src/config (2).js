export const CONFIG = {
  // Pulls directly from your Vercel environment variables (Added Next.js/Vite standard prefixes)
  keys: {
    GROQ: process.env.NEXT_PUBLIC_GROQ_API_KEY || process.env.VITE_GROQ_API_KEY || '', 
    OPENROUTER: process.env.NEXT_PUBLIC_OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '',
    GEMINI_1: process.env.NEXT_PUBLIC_GEMINI_API_KEY_1 || process.env.VITE_GEMINI_API_KEY_1 || '',
    TAVILY: process.env.NEXT_PUBLIC_TAVILY_API_KEY || process.env.VITE_TAVILY_API_KEY || ''
  },
  models: {
    spark: {
      id: 'spark',
      name: 'Spark',
      color: 'text-amber-400',
      bg: 'bg-amber-400/10',
      border: 'border-amber-400/50',
      minTokens: 2000,
      maxTokens: 3000,
      description: 'Instant, single-pass ultra-fast execution.'
    },
    flux: {
      id: 'flux',
      name: 'Flux',
      color: 'text-cyan-400',
      bg: 'bg-cyan-400/10',
      border: 'border-cyan-400/50',
      minTokens: 3000,
      maxTokens: 7000,
      description: 'Balanced dual-pass logic with contextual grounding.'
    },
    oracle: {
      id: 'oracle',
      name: 'Oracle',
      color: 'text-purple-500',
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/50',
      minTokens: 6000,
      maxTokens: 12000,
      description: 'Deep monolithic triple-pass reasoning & web-search.'
    }
  },
  systemRules: "You are Chatini, a premium AI. Format data visually using <chart>JSON</chart> tags when applicable."
};
