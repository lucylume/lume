const ytdl = require('@distube/ytdl-core');

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
    const { url, duration = 30 } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL manquante' });
    }

    console.log('🎬 Conversion request:', url);

    // Get video info
    const info = await ytdl.getInfo(url);
    const videoId = ytdl.getVideoID(url);
    
    // For now, return mock success response
    // Real video processing would need different architecture for Vercel
    const result = {
      success: true,
      downloadUrl: `https://example.com/mock-video-${videoId}.mp4`,
      transcription: "Transcription simulée pour test Vercel",
      videoTitle: info.videoDetails.title,
      duration: duration,
      segment: `0.0s-${duration}.0s`
    };

    console.log('✅ Mock conversion completed');
    res.status(200).json(result);

  } catch (error) {
    console.error('❌ Conversion error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Erreur de conversion: ${error.message}` 
    });
  }
}