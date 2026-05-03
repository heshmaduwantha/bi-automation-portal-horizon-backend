const axios = require('axios');

async function run() {
  const datasetId = '386e6fbb-c6fc-47b2-b17c-fdc722df4813';
  const url = `http://localhost:4020/powerbi/datasets/${datasetId}/execute-query`;
  
  try {
    const response = await axios.post(url, {
      query: "SELECT [Name], [IsHidden] FROM $SYSTEM.TMSCHEMA_TABLES"
    });
    const results = response.data.results[0].tables[0].rows;
    const visibleTables = results.filter(r => r['[IsHidden]'] === false || r['IsHidden'] === false);
    console.log('Visible tables:');
    console.log(JSON.stringify(visibleTables, null, 2));
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
  }
}

run();
