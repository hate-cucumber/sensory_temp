interface Env {
  KMA_SERVICE_KEY: string;
  KAKAO_REST_API_KEY: string;
}

type KmaItem = {
  baseDate: string;
  baseTime: string;
  category: string;
  nx: number;
  ny: number;
  obsrValue?: string;
  fcstDate?: string;
  fcstTime?: string;
  fcstValue?: string;
};

const KMA_BASE_URL =
  "https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0";

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}) {
  try {
    const url = new URL(context.request.url);
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ error: "lat, lon 값이 필요합니다." }, 400);
    }

    const grid = convertToGrid(lat, lon);
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    const address = await getAddress(lat, lon, context.env.KAKAO_REST_API_KEY);

    const ncstBase = getUltraSrtNcstBaseTime(kst);
    const fcstBase = getUltraSrtFcstBaseTime(kst);

    const [currentItems, forecastItems] = await Promise.all([
      fetchKmaItems({
        serviceKey: context.env.KMA_SERVICE_KEY,
        endpoint: "getUltraSrtNcst",
        baseDate: ncstBase.baseDate,
        baseTime: ncstBase.baseTime,
        nx: grid.nx,
        ny: grid.ny,
      }),
      fetchKmaItems({
        serviceKey: context.env.KMA_SERVICE_KEY,
        endpoint: "getUltraSrtFcst",
        baseDate: fcstBase.baseDate,
        baseTime: fcstBase.baseTime,
        nx: grid.nx,
        ny: grid.ny,
      }),
    ]);

    const currentTemp = findCurrentValue(currentItems, "T1H");
    const currentHumidity = findCurrentValue(currentItems, "REH");
    const currentWind = findCurrentValue(currentItems, "WSD");

    const currentFeelsLike = calculateFeelsLike({
      temperature: currentTemp,
      humidity: currentHumidity,
      windSpeed: currentWind,
      date: kst,
    });

    const forecastRows = buildForecastRows(forecastItems);

    const maxFeelsLike = forecastRows
      .filter(
        (row) =>
          Number.isFinite(row.temperature) &&
          Number.isFinite(row.humidity)
      )
      .map((row) => ({
        ...row,
        feelsLike: calculateFeelsLike({
          temperature: row.temperature,
          humidity: row.humidity,
          windSpeed: row.windSpeed,
          date: parseKstDate(row.date, row.time),
        }),
      }))
      .sort((a, b) => b.feelsLike - a.feelsLike)[0];

    return json({
      address,
      lat,
      lon,
      nx: grid.nx,
      ny: grid.ny,
      time: formatDateTime(kst),
      current: {
        temperature: round1(currentTemp),
        humidity: round1(currentHumidity),
        windSpeed: round1(currentWind),
        feelsLike: round1(currentFeelsLike),
      },
      maxFeelsLike: maxFeelsLike
        ? {
            date: maxFeelsLike.date,
            time: formatFcstTime(maxFeelsLike.time),
            temperature: round1(maxFeelsLike.temperature),
            humidity: round1(maxFeelsLike.humidity),
            windSpeed: round1(maxFeelsLike.windSpeed),
            feelsLike: round1(maxFeelsLike.feelsLike),
          }
        : null,
    });
  } catch (error) {
    return json(
      {
        error: "기상정보 조회 중 오류가 발생했습니다.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}

async function fetchKmaItems(params: {
  serviceKey: string;
  endpoint: "getUltraSrtNcst" | "getUltraSrtFcst";
  baseDate: string;
  baseTime: string;
  nx: number;
  ny: number;
}): Promise<KmaItem[]> {
  const url = new URL(`${KMA_BASE_URL}/${params.endpoint}`);

  url.searchParams.set("serviceKey", params.serviceKey);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("base_date", params.baseDate);
  url.searchParams.set("base_time", params.baseTime);
  url.searchParams.set("nx", String(params.nx));
  url.searchParams.set("ny", String(params.ny));

  const res = await fetch(url.toString());
  const data: any = await res.json();

  const code = data?.response?.header?.resultCode;
  if (code !== "00") {
    throw new Error(
      `기상청 API 오류: ${data?.response?.header?.resultMsg ?? "unknown"}`
    );
  }

  return data?.response?.body?.items?.item ?? [];
}

async function getAddress(
  lat: number,
  lon: number,
  kakaoKey: string
): Promise<string> {
  try {
    const url = new URL(
      "https://dapi.kakao.com/v2/local/geo/coord2address.json"
    );
    url.searchParams.set("x", String(lon));
    url.searchParams.set("y", String(lat));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `KakaoAK ${kakaoKey}`,
      },
    });

    if (!res.ok) return "주소 조회 실패";

    const data: any = await res.json();
    const doc = data?.documents?.[0];

    return (
      doc?.road_address?.address_name ||
      doc?.address?.address_name ||
      "주소 정보 없음"
    );
  } catch {
    return "주소 조회 실패";
  }
}

function findCurrentValue(items: KmaItem[], category: string): number {
  const item = items.find((v) => v.category === category);
  return Number(item?.obsrValue ?? NaN);
}

function buildForecastRows(items: KmaItem[]) {
  const map = new Map<
    string,
    {
      date: string;
      time: string;
      temperature: number;
      humidity: number;
      windSpeed: number;
    }
  >();

  for (const item of items) {
    if (!item.fcstDate || !item.fcstTime) continue;

    const key = `${item.fcstDate}-${item.fcstTime}`;
    const row =
      map.get(key) ??
      {
        date: item.fcstDate,
        time: item.fcstTime,
        temperature: NaN,
        humidity: NaN,
        windSpeed: NaN,
      };

    if (item.category === "T1H") row.temperature = Number(item.fcstValue);
    if (item.category === "REH") row.humidity = Number(item.fcstValue);
    if (item.category === "WSD") row.windSpeed = Number(item.fcstValue);

    map.set(key, row);
  }

  return [...map.values()];
}

function calculateFeelsLike(input: {
  temperature: number;
  humidity: number;
  windSpeed: number;
  date: Date;
}): number {
  const { temperature, humidity, windSpeed, date } = input;
  const month = date.getUTCMonth() + 1;

  if (!Number.isFinite(temperature)) return NaN;

  if (month >= 5 && month <= 9 && Number.isFinite(humidity)) {
    return calculateHeatIndex(temperature, humidity);
  }

  if (
    (month >= 10 || month <= 4) &&
    Number.isFinite(windSpeed) &&
    temperature <= 10 &&
    windSpeed >= 1.3
  ) {
    return calculateWindChill(temperature, windSpeed);
  }

  return temperature;
}

function calculateHeatIndex(t: number, rh: number): number {
  const hi =
    -8.784695 +
    1.61139411 * t +
    2.338549 * rh -
    0.14611605 * t * rh -
    0.012308094 * t * t -
    0.016424828 * rh * rh +
    0.002211732 * t * t * rh +
    0.00072546 * t * rh * rh -
    0.000003582 * t * t * rh * rh;

  return hi;
}

function calculateWindChill(t: number, windSpeedMs: number): number {
  const v = windSpeedMs * 3.6;
  return (
    13.12 +
    0.6215 * t -
    11.37 * Math.pow(v, 0.16) +
    0.3965 * Math.pow(v, 0.16) * t
  );
}

function getUltraSrtNcstBaseTime(kst: Date) {
  const d = new Date(kst);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() - 1);
  return {
    baseDate: formatYmd(d),
    baseTime: `${pad2(d.getUTCHours())}00`,
  };
}

function getUltraSrtFcstBaseTime(kst: Date) {
  const d = new Date(kst);
  const minute = d.getUTCMinutes();

  if (minute < 45) {
    d.setUTCHours(d.getUTCHours() - 1);
  }

  d.setUTCMinutes(30, 0, 0);

  return {
    baseDate: formatYmd(d),
    baseTime: `${pad2(d.getUTCHours())}30`,
  };
}

function parseKstDate(ymd: string, hm: string): Date {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const h = Number(hm.slice(0, 2));
  return new Date(Date.UTC(y, m - 1, d, h, 0, 0));
}

function formatDateTime(date: Date): string {
  return `${formatYmdHyphen(date)} ${pad2(date.getUTCHours())}:${pad2(
    date.getUTCMinutes()
  )}`;
}

function formatYmd(date: Date): string {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(
    date.getUTCDate()
  )}`;
}

function formatYmdHyphen(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;
}

function formatFcstTime(time: string): string {
  return `${time.slice(0, 2)}:${time.slice(2, 4)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function round1(n: number): number | null {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function convertToGrid(lat: number, lon: number) {
  const RE = 6371.00877;
  const GRID = 5.0;
  const SLAT1 = 30.0;
  const SLAT2 = 60.0;
  const OLON = 126.0;
  const OLAT = 38.0;
  const XO = 43;
  const YO = 136;

  const DEGRAD = Math.PI / 180.0;

  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn =
    Math.tan(Math.PI * 0.25 + slat2 * 0.5) /
    Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);

  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;

  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);

  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}
