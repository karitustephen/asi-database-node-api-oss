const output = document.getElementById('output');
const pingButton = document.getElementById('pingButton');

async function loadHealth() {
  try {
    const response = await fetch('/api/v1/health');
    const data = await response.json();
    output.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    output.textContent = `Error: ${error.message}`;
  }
}

pingButton.addEventListener('click', loadHealth);
loadHealth();
