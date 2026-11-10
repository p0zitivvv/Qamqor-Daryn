import test from 'node:test';
import assert from 'node:assert/strict';
import { BLEService } from '../js/ble.js';
import { calculateSDNN, calculateRMSSD, calculateRhythmIrregularity, checkECGSignalQuality, validatePulseOximetry } from '../js/signals.js';

test('1. ТОЛЬКО MAX30102: BPM и SpO2 принимаются, а ЭКГ корректно ожидает контакт', () => {
  const ble = new BLEService();
  let received = null;
  ble.onTelemetry = (t) => { received = t; };

  // Пакет только с пульсом и SpO2 (ЭКГ отсутствует или плоская 2048)
  ble.handlePacket('{"bpm":74,"spo2":98,"ecg":2048,"lo":1}');

  assert.ok(received, 'Телеметрия должна быть сформирована');
  assert.equal(received.bpm, 74, 'BPM должен быть 74');
  assert.equal(received.spo2, 98, 'SpO2 должен быть 98');
  assert.equal(received.hasActivePulse, true, 'hasActivePulse должен быть true');
  assert.equal(received.pulseSensorStatus, 'ok', 'Статус пульсоксиметра должен быть ok');

  // ЭКГ не должна блокировать пульс, но сама должна быть помечена как leads_off
  assert.equal(received.hasActiveECG, false, 'hasActiveECG должен быть false при обрыве электродов');
  assert.equal(received.ecg, null, 'ЭКГ должна быть null при leads off');
  assert.equal(received.ecgSensorStatus, 'leads_off', 'Статус ЭКГ должен быть leads_off');
  assert.equal(received.hasValidSensors, true, 'hasValidSensors = true т.к. один датчик валиден');
  assert.equal(received.status, 'receiving_pulse_only');
});

test('2. ТОЛЬКО AD8232: ЭКГ принимается и отрисовывается, а BPM и SpO2 равны null', () => {
  const ble = new BLEService();
  let received = null;
  ble.onTelemetry = (t) => { received = t; };

  // Пакет с активным сигналом ЭКГ, но без пальца на MAX30102 (bpm=0, spo2=0)
  ble.handlePacket('{"bpm":0,"spo2":0,"ecg":1845,"lo":0}');

  assert.ok(received, 'Телеметрия должна быть сформирована');
  assert.equal(received.hasActiveECG, true, 'hasActiveECG должен быть true');
  assert.equal(received.ecg, 1845, 'Значение ЭКГ должно быть 1845');
  assert.equal(received.ecgSensorStatus, 'ok', 'Статус ЭКГ должен быть ok');

  // Пульс и сатурация НЕ должны блокировать ЭКГ, но сами должны быть строго null
  assert.equal(received.bpm, null, 'BPM должен быть null без пальца на оптическом сенсоре');
  assert.equal(received.spo2, null, 'SpO2 должен быть null');
  assert.equal(received.hasActivePulse, false, 'hasActivePulse = false');
  assert.equal(received.pulseSensorStatus, 'no_finger', 'Статус пульсоксиметра должен быть no_finger');
  assert.equal(received.hasValidSensors, true, 'hasValidSensors = true благодаря ЭКГ');
  assert.equal(received.status, 'receiving_ecg_only');
});

test('3. ОБА ДАТЧИКА ОДНОВРЕМЕННО: одновременный приём всех биосигналов', () => {
  const ble = new BLEService();
  let received = null;
  ble.onTelemetry = (t) => { received = t; };

  ble.handlePacket('{"bpm":76,"spo2":99,"ecg":1920,"lo":0}');

  assert.ok(received);
  assert.equal(received.bpm, 76);
  assert.equal(received.spo2, 99);
  assert.equal(received.ecg, 1920);
  assert.equal(received.hasActivePulse, true);
  assert.equal(received.hasActiveECG, true);
  assert.equal(received.pulseSensorStatus, 'ok');
  assert.equal(received.ecgSensorStatus, 'ok');
  assert.equal(received.status, 'receiving');
});

test('4. ПОТЕРЯ СИГНАЛА MAX30102: палец убран, но поток ЭКГ продолжается без прерывания', () => {
  const ble = new BLEService();
  const telemetryHistory = [];
  ble.onTelemetry = (t) => { telemetryHistory.push(t); };

  // Сначала оба датчика работают
  ble.handlePacket('{"bpm":72,"spo2":97,"ecg":1850,"lo":0}');
  // Затем палец снят с оптического датчика (bpm=0, status=no_finger)
  ble.handlePacket('{"status":"no_finger","bpm":0,"spo2":0,"ecg":1870,"lo":0}');

  assert.equal(telemetryHistory.length, 2);
  const second = telemetryHistory[1];

  assert.equal(second.hasActiveECG, true, 'ЭКГ продолжает работать');
  assert.equal(second.ecg, 1870, 'Отсчет ЭКГ актуален');
  assert.equal(second.ecgSensorStatus, 'ok');
  assert.equal(second.bpm, null, 'BPM сброшен в null');
  assert.equal(second.spo2, null, 'SpO2 сброшен в null');
  assert.equal(second.pulseSensorStatus, 'no_finger');
});

test('5. ПОТЕРЯ СИГНАЛА AD8232: обрыв электродов ЭКГ не сбрасывает данные пульсоксиметра', () => {
  const ble = new BLEService();
  const telemetryHistory = [];
  ble.onTelemetry = (t) => { telemetryHistory.push(t); };

  // Сначала оба датчика работают
  ble.handlePacket('{"bpm":80,"spo2":96,"ecg":1950,"lo":0}');
  // Затем электроды ЭКГ отсоединяются (lo=1)
  ble.handlePacket('{"bpm":80,"spo2":96,"ecg":2048,"lo":1}');

  assert.equal(telemetryHistory.length, 2);
  const second = telemetryHistory[1];

  assert.equal(second.hasActivePulse, true, 'Пульсоксиметр продолжает работать');
  assert.equal(second.bpm, 80);
  assert.equal(second.spo2, 96);
  assert.equal(second.pulseSensorStatus, 'ok');
  assert.equal(second.hasActiveECG, false, 'ЭКГ отключена');
  assert.equal(second.ecg, null);
  assert.equal(second.ecgSensorStatus, 'leads_off');
});

test('6. ПАКЕТНЫЙ ПОТОК ЭКГ: поддержка массива отсчетов samples (250 Гц батч)', () => {
  const ble = new BLEService();
  let received = null;
  ble.onTelemetry = (t) => { received = t; };

  ble.handlePacket(JSON.stringify({
    type: 'ecg',
    samples: [1845, 1852, 1839, 1910, 2400],
    sampleRate: 250,
    lo: 0
  }));

  assert.ok(received);
  assert.equal(received.hasActiveECG, true);
  assert.equal(received.ecgSamples.length, 5);
  assert.deepEqual(received.ecgSamples, [1845, 1852, 1839, 1910, 2400]);
  assert.equal(received.ecg, 2400);
});

test('7. ФРАГМЕНТАЦИЯ BLE: склейка разорванного пакета по границам MTU', () => {
  const ble = new BLEService();
  let received = null;
  ble.onTelemetry = (t) => { received = t; };

  // Имитация прихода пакета двумя кусками (MTU chunking)
  ble.handlePacket('{"bpm":68,"sp');
  assert.equal(received, null, 'Неполный кусок не должен вызывать onTelemetry');

  ble.handlePacket('o2":98,"ecg":1890,"lo":0}');
  assert.ok(received, 'После склейки буфера должен сформироваться валидный объект');
  assert.equal(received.bpm, 68);
  assert.equal(received.spo2, 98);
  assert.equal(received.ecg, 1890);
});

test('8. ОБРАБОТКА ОЧЕРЕДИ: все полные пакеты в одном событии обрабатываются последовательно', () => {
  const ble = new BLEService();
  const receivedList = [];
  ble.onTelemetry = (t) => { receivedList.push(t); };

  // Два полных JSON пакета в одном буфере/нотификации
  ble.handlePacket('{"bpm":70,"spo2":98,"ecg":1800}{"bpm":72,"spo2":99,"ecg":1850}');

  assert.equal(receivedList.length, 2, 'Оба пакета должны быть обработаны, а не отброшен первый');
  assert.equal(receivedList[0].bpm, 70);
  assert.equal(receivedList[0].ecg, 1800);
  assert.equal(receivedList[1].bpm, 72);
  assert.equal(receivedList[1].ecg, 1850);
});

test('9. ПОВРЕЖДЕННЫЙ И НЕВАЛИДНЫЙ JSON: устойчивость без сбоев рантайма', () => {
  const ble = new BLEService();
  let errorCaught = false;
  ble.onError = () => { errorCaught = true; };

  // Невалидный мусор
  assert.doesNotThrow(() => {
    ble.handlePacket('???broken_ble_bytes\x00\x01\x02{"corrupted:123');
  });

  // Восстановление после мусора
  let validReceived = null;
  ble.onTelemetry = (t) => { validReceived = t; };
  ble.handlePacket('{"bpm":75,"spo2":97,"ecg":1820}');
  assert.ok(validReceived);
  assert.equal(validReceived.bpm, 75);
});

test('10. ОТСУТСТВИЕ ДАТЧИКОВ: строго null значения, никаких искусственных чисел', () => {
  const ble = new BLEService();
  let received = null;
  ble.onTelemetry = (t) => { received = t; };

  ble.handlePacket('{"status":"connected_no_data"}');

  assert.ok(received);
  assert.equal(received.bpm, null);
  assert.equal(received.spo2, null);
  assert.equal(received.ecg, null);
  assert.equal(received.hasValidSensors, false);
  assert.equal(received.hasActivePulse, false);
  assert.equal(received.hasActiveECG, false);
});

test('11. ВАЛИДАЦИЯ HRV: расчет SDNN и p_irr только при >= 5 валидных RR-интервалах', () => {
  // Менее 5 интервалов: расчет запрещен
  const fewIntervals = [0.85, 0.82, 0.84];
  assert.equal(calculateSDNN(fewIntervals), null, 'SDNN должен быть null при < 5 интервалах');
  assert.equal(calculateRMSSD(fewIntervals), null, 'RMSSD должен быть null при < 5 интервалах');
  assert.equal(calculateRhythmIrregularity(fewIntervals), null, 'p_irr должен быть null при < 5 интервалах');

  // 5 и более валидных интервалов: корректный расчет
  const validIntervals = [0.85, 0.82, 0.84, 0.86, 0.83, 0.85];
  const sdnn = calculateSDNN(validIntervals);
  assert.ok(typeof sdnn === 'number' && sdnn > 0, 'SDNN должен быть числом');
  const rmssd = calculateRMSSD(validIntervals);
  assert.ok(typeof rmssd === 'number' && rmssd > 0, 'RMSSD должен быть числом');
});

test('12. ПОЛНОЕ ОТКЛЮЧЕНИЕ BLE: очистка всех актуальных показаний и сброс детектора', () => {
  const ble = new BLEService();
  let lastTelemetry = null;
  ble.onTelemetry = (t) => { lastTelemetry = t; };

  // Сначала подаем данные
  ble.handlePacket('{"bpm":75,"spo2":98,"ecg":1900}');
  assert.equal(ble.isConnected, true);

  // Вызываем отключение
  ble.emitEmptyTelemetry('disconnected');

  assert.equal(ble.lastValidMeasurement, null);
  assert.equal(ble.pulseSensorStatus, 'disconnected');
  assert.equal(ble.ecgSensorStatus, 'disconnected');
  assert.equal(ble.bleConnectionStatus, 'disconnected');
  assert.equal(lastTelemetry.bpm, null);
  assert.equal(lastTelemetry.spo2, null);
  assert.equal(lastTelemetry.ecg, null);
  assert.equal(lastTelemetry.hasValidSensors, false);
});

test('13. BLE ПОДКЛЮЧЕН, НО УВЕДОМЛЕНИЯ ЕЩЕ НЕ ПОСТУПАЮТ: статус ожидания без фиктивных значений', () => {
  const ble = new BLEService();
  let telemetry = null;
  ble.onTelemetry = (t) => { telemetry = t; };

  // При подключении до прихода первого пакета
  ble.emitEmptyTelemetry('connected_no_data');

  assert.ok(telemetry);
  assert.equal(telemetry.bpm, null, 'До прихода пакета пульс строго null');
  assert.equal(telemetry.spo2, null, 'До прихода пакета SpO2 строго null');
  assert.equal(telemetry.ecg, null, 'До прихода пакета ЭКГ строго null');
  assert.equal(telemetry.pulseSensorStatus, 'waiting', 'Статус пульсоксиметра должен быть waiting');
  assert.equal(telemetry.ecgSensorStatus, 'waiting', 'Статус ЭКГ должен быть waiting');
  assert.equal(telemetry.hasValidSensors, false);
});

test('14. ПРЕКРАЩЕНИЕ ПЕРЕДАЧИ ДАТЧИКА: сброс в null при потере контакта без подмены демо-данными', () => {
  const ble = new BLEService();
  const history = [];
  ble.onTelemetry = (t) => { history.push(t); };

  // 1. Полноценная передача
  ble.handlePacket('{"bpm":78,"spo2":97,"ecg":1950,"lo":0}');
  assert.equal(history[0].bpm, 78);
  assert.equal(history[0].ecg, 1950);

  // 2. Пользователь убрал палец (irValue < 10000 -> bpm:0, spo2:0), но ЭКГ продолжается
  ble.handlePacket('{"bpm":0,"spo2":0,"ecg":1980,"lo":0}');
  assert.equal(history[1].bpm, null, 'BPM не должен оставаться 78, а должен стать null');
  assert.equal(history[1].spo2, null, 'SpO2 должен стать null');
  assert.equal(history[1].ecg, 1980, 'ЭКГ продолжает поступать');
  assert.equal(history[1].pulseSensorStatus, 'no_finger');
  assert.equal(history[1].ecgSensorStatus, 'ok');

  // 3. Электроды сняты (lo:1)
  ble.handlePacket('{"bpm":0,"spo2":0,"ecg":2048,"lo":1}');
  assert.equal(history[2].bpm, null);
  assert.equal(history[2].spo2, null);
  assert.equal(history[2].ecg, null);
  assert.equal(history[2].pulseSensorStatus, 'no_finger');
  assert.equal(history[2].ecgSensorStatus, 'leads_off');
  assert.equal(history[2].hasValidSensors, false);
});
