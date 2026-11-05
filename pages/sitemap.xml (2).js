const EXTERNAL_DATA_URL = 'https://lexis-ai-chatini.vercel.app';

function generateSiteMap(useCases) {
  return `<?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     <!-- Main Landing Page -->
     <url>
       <loc>${EXTERNAL_DATA_URL}</loc>
       <priority>1.0</priority>
       <changefreq>daily</changefreq>
     </url>
     <!-- Programmatic SEO Landing Pages -->
     ${useCases
       .map(({ slug }) => {
         return `
       <url>
           <loc>${`${EXTERNAL_DATA_URL}/tools/${slug}`}</loc>
           <priority>0.8</priority>
           <changefreq>weekly</changefreq>
       </url>
     `;
       })
       .join('')}
   </urlset>
 `;
}

export default function SiteMap() {
  // getServerSideProps will do the heavy lifting, 
  // so this component does not need to render anything.
}

export async function getServerSideProps({ res }) {
  // These MUST match the array used in your api/growth.js file
  const useCases = [
    { slug: 'analyze-massive-codebases' },
    { slug: 'summarize-legal-contracts' },
    { slug: 'process-large-datasets-with-live-search' },
    { slug: 'higher-context-research-groups' },
    { slug: 'unthrottled-ai-document-analysis' }
  ];

  // We generate the XML sitemap with the use case data
  const sitemap = generateSiteMap(useCases);

  // Set the response header so search engines know it is an XML file
  res.setHeader('Content-Type', 'text/xml');
  
  // Send the XML to the browser/crawler
  res.write(sitemap);
  res.end();

  return {
    props: {},
  };
}
