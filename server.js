const { app, initDb } = require('./app');

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Team leave calendar running at http://localhost:${PORT}`);
      console.log(`Teammates on the same network can use http://<your-ip>:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
