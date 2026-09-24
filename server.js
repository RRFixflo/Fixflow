const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the report tool as a static file — Railway sets PORT itself, so we read it
// from the environment rather than hardcoding it.
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Report tool running on port ${PORT}`);
});
