import "./style.css";

const loadBtn = document.querySelector<HTMLButtonElement>("#loadBtn")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const resultEl = document.querySelector<HTMLElement>("#result")!;

loadBtn.addEventListener("click", async () => {
  try {
    setStatus("현재 위치를 확인하고 있습니다.");
    loadBtn.disabled = true;

    const position = await getCurrentPosition();

    const lat = position.coords.latitude;
    const lon = position.coords.longitude;

    setStatus("기상청 데이터를 조회하고 있습니다.");

    const res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error ?? "조회 실패");
    }

    render(data);
    setStatus("조회가 완료되었습니다.");
    resultEl.classList.remove("hidden");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "오류가 발생했습니다.");
  } finally {
    loadBtn.disabled = false;
  }
});

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("브라우저가 위치 정보를 지원하지 않습니다."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 300000,
    });
  });
}

function render(data: any) {
  setText("address", data.address);
  setText("lat", data.lat?.toFixed(6));
  setText("lon", data.lon?.toFixed(6));
  setText("time", data.time);

  setText("currentTemp", value(data.current?.temperature));
  setText("currentHumidity", value(data.current?.humidity));
  setText("currentFeels", value(data.current?.feelsLike));

  if (data.maxFeelsLike) {
    setText("maxTime", `${data.maxFeelsLike.date} ${data.maxFeelsLike.time}`);
    setText("maxTemp", value(data.maxFeelsLike.temperature));
    setText("maxHumidity", value(data.maxFeelsLike.humidity));
    setText("maxFeels", value(data.maxFeelsLike.feelsLike));
  }

  const hourlyEl = document.getElementById("hourlyFeelsLike");

  if (hourlyEl) {
    hourlyEl.innerHTML = "";

    if (Array.isArray(data.hourlyFeelsLike)) {
      for (const item of data.hourlyFeelsLike) {
        const div = document.createElement("div");
        div.className = "hourly-item";

        div.innerHTML = `
          <strong>${item.hourAfter}시간 뒤</strong>
          <span>${item.time}</span>
          <span>기온 ${item.temperature ?? "-"}℃</span>
          <span>습도 ${item.humidity ?? "-"}%</span>
          <span>체감 ${item.feelsLike ?? "-"}℃</span>
        `;

        hourlyEl.appendChild(div);
      }
    }
  }
}

function setStatus(message: string) {
  statusEl.textContent = message;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function value(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : String(v);
}
