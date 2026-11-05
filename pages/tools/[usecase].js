// pages/tools/[usecase].js
import Head from 'next/head';
import Link from 'next/link';

export default function ToolPage({ usecase, formattedTitle }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-cyan-500/30">
      <Head>
        <title>{formattedTitle} | LexisAI Higher Context & Live Web Search</title>
        <meta name="description" content={`Free tool to ${formattedTitle.toLowerCase()} using LexisAI's higher context virtualization, high usage limits, and live web search.`} />
      </Head>

      <main className="max-w-4xl mx-auto px-6 py-20 text-center flex flex-col items-center justify-center">
        <h1 className="text-4xl md:text-6xl font-extrabold mb-6 tracking-tight">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-500">
            {formattedTitle}
          </span>
        </h1>
        
        <p className="text-gray-400 text-lg mb-10 max-w-2xl leading-relaxed">
          Standard interfaces crash when you give them massive files. They also lack real-time data. To effectively handle <strong>{formattedTitle.toLowerCase()}</strong>, you require a higher context window and real-time internet data.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12 w-full text-left"> 
          <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-2">🧠 Higher Context</h3>
            <p className="text-gray-400 text-sm">Upload massive datasets without data truncation or token limits.</p>
          </div>
          <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-2">🌐 Live Web Search</h3>
            <p className="text-gray-400 text-sm">Cross-reference your data with live internet indexing instantly.</p>
          </div>
          <div className="p-6 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-lg font-bold text-white mb-2">👥 Create Groups</h3>
            <p className="text-gray-400 text-sm">Create group workspaces to collaborate on massive payloads together.</p>
          </div>
        </div>

        {/* The Conversion Funnel */}
        <Link 
          href="/" 
          className="px-8 py-4 bg-white text-black font-bold rounded-lg text-lg hover:bg-gray-200 transition-colors shadow-[0_0_30px_rgba(255,255,255,0.2)]" 
        >
          Launch LexisAI Engine Free
        </Link>
      </main>
    </div>
  );
}

// Vercel Edge/Serverless dynamic routing
export async function getServerSideProps({ params }) {
  const { usecase } = params;
  
  // Converts URL slug (e.g., "analyze-medical-pdfs") into a clean Title
  const formattedTitle = usecase
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .replace(/Ai/gi, 'LexisAI');

  return {
    props: {
      usecase,
      formattedTitle,
    },
  };
}
