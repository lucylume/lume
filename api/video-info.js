export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL manquante' });
    }

    // Extract video ID from URL
    const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
    
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'URL YouTube invalide' });
    }

    // Return basic info without ytdl (to avoid bot detection)
    const result = {
      success: true,
      title: "Vidéo YouTube",
      channel: "Chaîne YouTube",
      videoId: videoId
    };

    res.status(200).json(result);

  } catch (error) {
    console.error('Video info error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}