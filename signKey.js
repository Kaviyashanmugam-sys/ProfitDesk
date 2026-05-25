const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');

const WABA_ID = '1010240645024252';
const ACCESS_TOKEN = 'EAAUt1ZCfO6pYBRoZAAnCAUGsT6YXhVRX6wHgpGv0iEhXezThuojcJxLj2Pb5TYBuFHOXkFZBVwZAKgmgTKq1ZCdetzTtx9cBijDXJeggtOdI9T8fSnK29bADs2rnJenCM5ZA7O228SuIq7Tbkk2ebFgPZBQf6hsKxLV99ZCuDPnYyECEoueormY66LHeeQU84ZBlHzSB3pU5tD0XTxGZAvCB6Ulxgo5b1WVjTC11t5';

async function signPublicKey() {
  try {
    const form = new FormData();
    form.append('business_public_key', fs.createReadStream('./public.pem'));

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${WABA_ID}/whatsapp_business_encryption`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      }
    );

    console.log('✅ Success:', response.data);
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
}

signPublicKey();