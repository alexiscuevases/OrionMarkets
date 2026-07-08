-- Reset de datos DERIVADOS tras el endurecimiento de los detectores (v2):
-- filtros de sesión/volatilidad/contra-tendencia, stops más anchos y
-- confirmación de rupturas cambian niveles y universo de señales.
--
-- signals y evaluations se regeneran por completo desde `candles` (que se
-- conserva intacta) en la siguiente ejecución del pipeline: sin este reset,
-- INSERT OR IGNORE mantendría las filas antiguas (misma sig_key, niveles
-- viejos) y las estadísticas TP/SL seguirían mezclando ambas lógicas.

DELETE FROM evaluations;
DELETE FROM signals;
