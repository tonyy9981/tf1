const scriptName = "TestFlight";
const tfAppIdKey = "tf_app_id";
const tfJoinedAppIdKey = "tf_joined_app_id";
const tfInvalidAppIdKey = "tf_invalid_app_id";
const tfSessionInfoKey = "tf_session_info";
const tfCheckSessionTimeKey = "tf_check_session_time";
const tfCheckSessionTimeDiffKey = "tf_check_session_time_diff";
const tfAppUseAccountIdKey = "tf_app_use_account_id";
const tfStorefrontId = "tf_storefront_id";
const getSessionRegex = /^https:\/\/testflight\.apple\.com\/v3\/accounts\/(\w{8}-\w{4}-\w{4}-\w{4}-\w{12})\/apps$/;
const getFullAppIdRegex = /^https:\/\/testflight\.apple\.com\/v3\/accounts\/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\/ru\/([a-zA-Z0-9]{8})$/;
const modifyTFRequest = /^https:\/\/testflight\.apple\.com\/v\d\/accounts\/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\/apps\/\d+/
const modifySettingsTFRequest = /^https:\/\/testflight\.apple\.com\/v\d\/accounts\/settings\/.*\/apps\/\d+/
const modifyInstallTFRequest = /^https:\/\/testflight\.apple\.com\/v\d\/apps\/\d+\/\d+\/install\/status$/
const $ = MagicJS(scriptName, "INFO");
const blankSessionInfo = {
  "x-session-id": "", "x-session-digest": "", "x-request-id": "", "valid": false
};
// Chế độ tham gia TestFlight，0: Nhẹ 1: Tiêu chuẩn 2: Bạo lực
const tfJoinMode = parseInt($.data.read("tf_join_mode", 1));
// Số yêu cầu đồng thời khi cố gắng tham gia TestFlight
const tfJoinConcurrency = parseInt($.data.read("tf_join_concurrency", 2));
// Số vòng lặp khi thực thi lệnh
const tfLoopCount = parseInt($.data.read("tf_loop_count", 5));
// Tài khoản AppleID chuyên dụng kiểm tra tính khả dụng của TestFlight
let tfCheckAccountId = $.data.read('tf_check_account_id', '');
// Đồng bộ dữ liệu với bảng qinglong
const syncqinglong = $.data.read("tf_sync_qinglong", false);


function removeHeaders(config) {
  let headers = {...config["headers"]};
  delete headers["valid"];
  delete headers["if-none-match"];
  delete headers["If-None-Match"];
  config["headers"] = headers;
  return config;
}

$.http.interceptors.request.use(removeHeaders);

function modifyHeaders(accountId, headers, session, url = "") {
  let newHeaders = {...headers, ...session};
  delete newHeaders["valid"];
  if ($.env.isQuanX || $.env.isStash) {
    newHeaders = $.http.convertHeadersToCamelCase(newHeaders);
    delete headers["If-None-Match"];
  } else {
    newHeaders = $.http.convertHeadersToLowerCase(newHeaders);
    delete headers["if-none-match"];
  }
  $.logger.info(`Sửa đổi tiêu đề yêu cầu\n${JSON.stringify(newHeaders)}`);
  return newHeaders;
}

function modifyRequest() {
  $.logger.info(`Địa chỉ yêu cầu\n${$.request.url}`);
  let url = $.request.url;
  let headers = $.request.headers;
  let body = $.request.body ? JSON.parse($.request.body) : {};
  const result = /apps\/(\d+)/.exec($.request.url);
  if (result) {
    const appAdamId = result[1];
    const appUseAccountId = $.data.read(tfAppUseAccountIdKey, {});
    if (appAdamId in appUseAccountId) {
      const accountId = appUseAccountId[appAdamId];
      const session = $.data.read(tfSessionInfoKey, blankSessionInfo, accountId);
      url = url.replace(/accounts\/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}/, `accounts/${accountId}`);
      $.logger.info(`Sửa đổi địa chỉ yêu cầu thành\n${url}`);
      headers = modifyHeaders(accountId, headers, session, url);
    }
  }
  if (/\/install$/.test($.request.url) && Object.keys(body).length > 0) {
    body.storefrontId = $.data.read(tfStorefrontId, "143441-19,29");
  }
  return [url, headers, JSON.stringify(body)];
}

function getAccountAppData(currentAccountId, accountId, headers) {
  return new Promise(resolve => {
    $.http.get({
      url: `https://testflight.apple.com/v3/accounts/${accountId}/apps`, headers: headers
    }).then(resp => {
      let obj = resp.body;
      obj["account_id"] = accountId;
      // Tài khoản hiện tại giữ lại dữ liệu ứng dụng "đã thử nghiệm trước đó"
      if (currentAccountId !== accountId) {
        obj["data"] = obj["data"].filter(app => app["previouslyTested"] === false);
      }
      $.logger.info(`Tài khoản ${accountId} nhận được ứng dụng ${obj["data"].length} `);
      resolve(obj);
    }).catch(async err => {
      if (err.response.status === 401) {
        $.notification.post(`Session của AccountId ${accountId} đã hết hạn`);
        let sessionInfo = $.data.read(tfSessionInfoKey, blankSessionInfo, accountId);
        sessionInfo["valid"] = false;
        $.data.write(tfSessionInfoKey, sessionInfo, accountId)
        try {
          if (syncqinglong === true) {
            let qlSessionInfo = await $.qinglong.read(tfSessionInfoKey, {}, accountId);
            if (qlSessionInfo && qlSessionInfo["x-request-id"] === sessionInfo["x-request-id"] && qlSessionInfo["valid"] === true) {
              await $.qinglong.write(tfSessionInfoKey, sessionInfo, accountId);
              $.notification.post(`AccountId ${accountId} đồng thời trong bảng qinglong đã được đặt thành không hợp lệ`);
            }
          }
        } catch (err) {
          $.logger.error(`Ngoại lệ xảy ra khi AccountId ${accountId} được đặt thành không hợp lệ trong bảng qinglong\n${err}`);
        }
        resolve({data: [], account_id: accountId});
      } else {
        $.logger.error(`Ngoại lệ xảy ra khi AccountId ${accountId} lấy danh sách ứng dụng\n${JSON.stringify(err)}`);
        resolve({data: [], account_id: accountId});
      }
    })
  })
}

async function getAllAppData() {
  try {
    const currentAccountId = $.request.url.match(getSessionRegex)[1];
    $.logger.info(`Tài khoản hiện tại là：${currentAccountId}`);
    let obj = $.response.status === 200 ? JSON.parse($.response.body) : {"data": [], "error": null};
    $.logger.debug(`Danh sách ứng dụng được yêu cầu là：\n${JSON.stringify(obj)}`);
    let allSessions = $.data.read(tfSessionInfoKey, null, "", true);
    let accountIdList = Object.keys(allSessions);
    // Đảm bảo tài khoản hiện tại được xếp hạng đầu tiên trong mảng để đảm bảo dữ liệu App của tài khoản hiện tại được sử dụng đầu tiên
    if ($.response.status === 304) {
      accountIdList = accountIdList.filter(accountId => accountId !== currentAccountId);
      accountIdList.unshift(currentAccountId);
    }
    const promises = accountIdList.filter(accountId => {
      return accountId !== 'magic_session' && ($.response.status !== 200 || accountId !== currentAccountId) && allSessions[accountId]['valid'] === true
    }).map(accountId => {
      let session = allSessions[accountId];
      return getAccountAppData(currentAccountId, accountId, modifyHeaders(accountId, $.request.headers, session));
    });

    $.logger.info(`Có tổng cộng ${promises.length} tài khoản cần lấy danh sách ứng dụng`);

    await Promise.all(promises)
      .then((results) => {
        let appAccountMap = new Map();
        for (let result of results) {
          if (result !== undefined && typeof result["data"] !== undefined) {
            for (let appData of result["data"]) {
              const appAdamId = appData["appAdamId"].toString();
              if (appAccountMap.has(appAdamId) === false) {
                appAccountMap.set(appAdamId, result["account_id"]);
                obj["data"].push(appData);
              }
            }
          } else {
            $.logger.warning(`Dữ liệu ứng dụng thu được không xác định`);
          }
        }
        $.data.write(tfAppUseAccountIdKey, Object.fromEntries(appAccountMap));
      })
      .catch(error => {
        // Xử lý lỗi
        $.logger.error(`Đã xảy ra ngoại lệ khi lấy dữ liệu ứng dụng\n${JSON.stringify(error)}`);
      });
    $.logger.debug(`Dữ liệu ứng dụng cho tất cả tài khoản hợp lệ\n${JSON.stringify(obj)}`);
    return {body: JSON.stringify(obj)};
  } catch (err) {
    $.logger.error(`Có một ngoại lệ trong việc lấy dữ liệu Ứng dụng của tất cả các tài khoản hợp lệ.\n${err}`);
    return {body: $.response.body};
  }
}

async function syncToqinglong(currentAccountId = "", currentSessionInfo = null) {

  if (syncqinglong === true) {
    try {

      let silentSync = true; // Đồng bộ im lặng, sẽ không có thông báo nào bật lên cho việc đồng bộ này
      let [qlAllSessions, qlAppIds] = await $.qinglong.batchRead([tfSessionInfoKey, {}, "", true], [tfAppIdKey, ""]);
      let batchWriteData = [];

      // Đồng bộ Session với bảng điều khiển qinglong
      if (currentAccountId !== "" && currentSessionInfo !== null) {
        try {
          const qlSessionInfo = qlAllSessions[currentAccountId];
          $.logger.info(`SessionInfo cũ trong bảng qinglong\n${JSON.stringify(qlSessionInfo)}`);
          if (!qlSessionInfo || qlSessionInfo["x-session-id"] !== currentSessionInfo["x-session-id"] || qlSessionInfo["valid"] === false) {
            $.logger.info(`Các điều kiện đồng bộ được đáp ứng và Session hiện tại đã được đồng bộ với Bảng điều khiển qinglong.`);
            batchWriteData.push([tfSessionInfoKey, currentSessionInfo, currentAccountId]);
          } else {
            $.logger.info(`Các điều kiện đồng bộ không được đáp ứng và không cần phải đồng bộ Session hiện tại với bảng qinglong.`);
          }
          if (!qlSessionInfo || qlSessionInfo["valid"] === false){
            silentSync = false;
          }
        } catch
          (error) {
          $.logger.error(`Đã xảy ra ngoại lệ khi đồng bộ Session hiện tại với bảng qinglong.\n${error}`);
        }
      }

      // Đồng bộ AppId với bảng qinglong
      try {
        let tfAppIds = $.data.read(tfAppIdKey, "").split(";");
        qlAppIds = qlAppIds.split(";").filter(appId => appId !== "");
        // Xác định xem có AppId không tồn tại trên bảng qinglong hay không
        let newAppIds = tfAppIds.filter(x => x !== "" && !qlAppIds.includes(x));
        if (newAppIds.length > 0) {
          qlAppIds = qlAppIds.concat(tfAppIds);
          qlAppIds = [...new Set(qlAppIds)];
          $.logger.info(`Lần này bạn cần cập nhật AppId của bảng qinglong\n${qlAppIds.join(";")}`);
          let strAppIds = "";
          if (qlAppIds.length === 1) {
            strAppIds = qlAppIds[0];
          } else if (qlAppIds.length > 1) {
            strAppIds = qlAppIds.join(";")
          }
          batchWriteData.push([tfAppIdKey, strAppIds]);
          silentSync = false;
        } else {
          $.logger.info(`Tất cả AppId đã tồn tại trong bảng qinglong và việc đồng bộ này sẽ không được thực hiện!`);
        }
      } catch (error) {
        $.logger.error(`Ngoại lệ xảy ra khi đồng bộ AppId với bảng qinglong\n${error}`);
      }

      // Đồng bộ dữ liệu bảng qinglong thành cục bộ
      try {
        $.logger.debug(`Tất cả SessionInfo trong bảng điều khiển qinglong\n${JSON.stringify(qlAllSessions)}`);
        // Duyệt qua Session được lưu trữ trong bảng qinglong
        for (let accountId of Object.keys(qlAllSessions)) {
          // So sánh với Session cục bộ, nếu không nhất quán, hãy cập nhật Session cục bộ
          if (accountId !== "magic_session" && qlAllSessions[accountId]["valid"] === true && accountId !== currentAccountId) {
            const localSession = $.data.read(tfSessionInfoKey, {}, accountId);
            const qlSession = qlAllSessions[accountId];
            if (localSession["x-request-id"] !== qlSession["x-request-id"] || localSession["valid"] === false) {
              $.data.write(tfSessionInfoKey, qlSession, accountId);
              $.logger.info(`Đồng bộ session của bảng qinglong ${accountId} với phiên bản cục bộ`);
            }
          }
        }
      } catch (error) {
        $.logger.error(`Một ngoại lệ đã xảy ra khi đồng bộ session của bảng điều khiển qinglong với bộ nhớ cục bộ.\n${JSON.stringify(error)}`);
      }
      // Ghi dữ liệu theo lô
      const result = await $.qinglong.batchWrite(...batchWriteData);
      if (result === true) {
        if (silentSync === false) {
          $.notification.post(
            `${scriptName} ${currentAccountId}`,
            "",
            `Thông tin của bạn đã được đồng bộ với bảng qinglong：\n${$.qinglong.url}\nNếu địa chỉ trên không phải do bạn cấu hình thì thông tin đã bị rò rỉ!\nHãy tắt tập lệnh ngay lập tức và thay đổi mật khẩu của bạn!\nKiểm tra xem cấu hình bảng qinglong có bị giả mạo hay không!`);
        } else {
          $.logger.info(`Thông tin tương tự đã tồn tại trong bảng qinglong, vì vậy sẽ không có thông báo nào bật lên về việc đồng bộ này!\nThông tin của bạn đã được đồng bộ với bảng qinglong：\n${$.qinglong.url}\nNếu địa chỉ trên không phải do bạn cấu hình thì thông tin đã bị rò rỉ!\nVui lòng tắt tập lệnh và thay đổi mật khẩu của bạn ngay lập tức!\nKiểm tra xem cấu hình bảng qinglong có bị giả mạo không!`);
        }
      } else {
        $.notification.post(`Không thể đồng bộ thông tin của bạn với bảng qinglong：\n${$.qinglong.url}\nVui lòng kiểm tra cấu hình bảng điều khiển qinglong!`);
      }
    } catch (error) {
      $.logger.error(`Đã xảy ra ngoại lệ khi đồng bộ hóa dữ liệu với bảng qinglong\n${error}`);
      $.notification.post(`Không thể đồng bộ thông tin của bạn với bảng qinglong：\n${$.qinglong.url}\nVui lòng kiểm tra cấu hình bảng điều khiển qinglong!`);
    }
  }
}

async function getTFSessionInfo() {
  try {
    const matches = $.request.url.match(/\/accounts\/([a-zA-Z0-9-]+)\/apps/);
    if (matches && matches.length > 1) {
      // Id tài khoản
      const accountId = matches[1];
      // Nhận dữ liệu TestFlight Session cũ
      const oldSessionInfo = $.data.read(tfSessionInfoKey, blankSessionInfo, accountId);
      $.logger.info(`SessionInfo cũ:\n${JSON.stringify(oldSessionInfo)}`);
      // Nhận dữ liệu TestFlight Session mới
      $.logger.info(`Headers hiện tại:\n${JSON.stringify($.request.headers)}`);
      const newSessionInfo = {
        "valid": true,
        "x-session-id": $.request.headers["x-session-id"] || $.request.headers["X-Session-Id"],
        "x-session-digest": $.request.headers["x-session-digest"] || $.request.headers["X-Session-Digest"],
        "x-request-id": $.request.headers["x-request-id"] || $.request.headers["X-Request-Id"],
      };
      $.logger.info(`SessionInfo mới\n${JSON.stringify(newSessionInfo)}`);
      // Dữ liệu Session không được ghi đồng thời
      if (oldSessionInfo["x-session-id"] !== newSessionInfo["x-session-id"]) {
        $.data.write(tfSessionInfoKey, newSessionInfo, accountId);
        const tempSessionInfo = $.data.read(tfSessionInfoKey, blankSessionInfo, accountId);
        if (newSessionInfo["x-session-id"] === tempSessionInfo["x-session-id"]) {
          $.notification.post(`${scriptName} - ${accountId}`, "", "Các thông tin cần thiết cho TestFlight đã được ghi thành công.");
        } else {
          $.notification.post(`${scriptName} - ${accountId}`, "", "Không thể ghi thông tin cần thiết cho TestFlight");
        }
      }
      // Đồng bộ hóa dữ liệu với bảng qinglong
      await syncToqinglong(accountId, newSessionInfo);
    } else {
      $.logger.error(`Không thể lấy AccountId của TestFlight, vui lòng kiểm tra cấu hình.`);
    }
  } catch (err) {
    const errMsg = `Đã xảy ra ngoại lệ khi lấy thông tin cần thiết cho TestFlight.`;
    $.notification.post(errMsg);
    $.logger.error(`${errMsg}\n${err}`);
  }
}

async function autoAddAppId() {
  let obj = JSON.parse($.response.body);
  const match = $.request.url.match(getFullAppIdRegex);
  const appId = match[1];
  let tfAppIds = $.data.read(tfAppIdKey, "").split(";");
  tfAppIds = tfAppIds.filter(appId => {
    return appId !== ""
  });
  $.logger.info(`Danh sách App yêu thích TF hiện có:${JSON.stringify(tfAppIds)}`);
  if (obj.data.status === "FULL") {
    if (!tfAppIds.includes(appId)) {
      tfAppIds.push(appId);
      let strAppIds = "";
      if (tfAppIds.length === 1) {
        strAppIds = appId;
      } else if (tfAppIds.length > 1) {
        strAppIds = tfAppIds.join(";")
      }
      $.data.write(tfAppIdKey, strAppIds);
      const msg = `Ứng dụng [${appId}] đã đầy và tự động được thêm vào danh sách yêu thích TestFlight`;
      $.logger.info(msg);
      $.notification.post(msg)
    } else {
      $.logger.info(`Ứng dụng [${appId}] đã tồn tại trong danh sách mong muốn TestFlight và sẽ không được thêm lại lần này.`);
    }
    await syncToqinglong();
  } else {
    $.logger.info(`Ứng dụng [${appId}] chưa đầy hoặc chưa mở, vui lòng tự tham gia`);
  }
}

function getAppTestFlightHtml(appId) {
  return new Promise((resolve) => {
    const url = `https://testflight.apple.com/join/${appId}`;
    $.http
      .get({url, timeout: 5000})
      .then((resp) => {
        if (resp.status === 200 && (resp.body.indexOf("Phiên bản beta này có rất nhiều người thử nghiệm") > 0 || resp.body.indexOf("This beta is full") > 0)) {
          $.logger.info(`AppId: [${appId}] Hết slot rồi baby !`);
          resolve("FULL");
        } else {
          $.logger.info(`AppId: [${appId}] Đang mở`);
          $.logger.info(`Response hiện tại:\n${resp.body}`);
          resolve("NOT_FULL");
        }
      })
      .catch((err) => {
        if (err.response.status === 404) {
          $.logger.warning(`AppId: [${appId}] không tồn tại`);
          resolve("NO_EXIST");
        } else {
          $.logger.warning(`Đã xảy ra ngoại lệ khi lấy thông tin TestFlight.\n${JSON.stringify(err)}`);
          resolve("ERROR");
        }
      });
  });
}

function getAppTestFlightJson(accountId, sessionInfo, appId) {
  return new Promise((resolve) => {
    const url = `https://testflight.apple.com/v3/accounts/${accountId}/ru/${appId}`;
    $.http
      .get({
        url, headers: {...sessionInfo}, timeout: 5000
      })
      .then((resp) => {
        if (resp.status === 200) {
          if (resp.body.data.status === "FULL") {
            $.logger.info(`App [${resp.body.data.app.name}] Chiếm đóng hoàn toàn`);
            resolve([false, resp.status]);
          } else if (resp.body.data.status === "OPEN") {
            $.logger.info(`App [${resp.body.data.app.name}] Không đầy`);
            resolve([true, resp.status]);
          } else {
            $.logger.info(`App [${resp.body.data.app.name}] Trạng thái không xác định:${resp.body.data.status}`);
            resolve([false, resp.status]);
          }
        } else {
          $.logger.warning(`Đã xảy ra lỗi khi nhận trạng thái thử nghiệm App Beta`);
          resolve([false, resp.status]);
        }
      })
      .catch((err) => {
        if (err.response.status === 404) {
          $.logger.warning(`App${appId}không tồn tại`);
          let invalidAppIds = $.data.read(tfInvalidAppIdKey, []);
          invalidAppIds.push(appId);
          $.data.write(tfInvalidAppIdKey, invalidAppIds);
          resolve([false, err.response.status]);
        } else if (err.response.status === 401) {
          $.logger.warning(`Xảy ra lỗi trái phép khi nhận trạng thái thử nghiệm App Beta, vui lòng cập nhật session.`);
          resolve([false, err.response.status]);
        } else if (err.response && err.response.status) {
          $.logger.warning(`Đã xảy ra lỗi khi nhận trạng thái thử nghiệm App Beta：\n${JSON.stringify(err)}，http code: ${err.response.status}`);
          resolve([false, err.response.status]);
        } else {
          $.logger.warning(`Đã xảy ra lỗi khi nhận trạng thái thử nghiệm App Beta：\n${err}`);
          resolve([false, undefined]);
        }
      });
  });
}

function joinTestFlight(accountId, sessionInfo, appId) {
  return new Promise((resolve) => {
    const url = `https://testflight.apple.com/v3/accounts/${accountId}/ru/${appId}/accept`;
    $.http
      .post({
        url, headers: sessionInfo,
      })
      .then((resp) => {
        if (resp.status === 200) {
          // Lưu trữ AppId đã tham gia
          let tfJoinedAppIds = $.data.read(tfJoinedAppIdKey, [], accountId);
          if (!tfJoinedAppIds.includes(appId)) {
            tfJoinedAppIds.push(appId);
            tfJoinedAppIds = [...new Set(tfJoinedAppIds)];
            $.data.write(tfJoinedAppIdKey, tfJoinedAppIds, accountId);
          }
          $.logger.info(`Đã tham gia thành công[${resp.body.data.name}]`);
          resolve([true, appId, resp.body.data.name, accountId]);
        } else {
          $.logger.info(`Tham gia[${appId}]thất bại`);
          $.notification.post(`Tham gia[${appId}]thất bại`);
          resolve([false, appId, resp.body.data.name, accountId]);
        }
      })
      .catch((err) => {
        if (err && err.response && err.response.status === 409) {
          $.logger.warning(`Buộc tham gia ${appId} thất bại`);
        }
        $.logger.warning(`Đã xảy ra ngoại lệ khi tham gia App ${appId}\n${JSON.stringify(err)}`);
        $.notification.post(`Tham gia [${appId}] thất bại`);
        resolve([false, appId, "", accountId]);
      });
  });
}

async function startJoinAppTestFlight(accountIds, accountsSessionInfo, appId) {
  if (accountIds.length === 0) {
    return [];
  }
  let joinPromise = [];
  for (let accountId of accountIds) {
    // Đi qua N lần và thử tham gia TestFlight
    for (let i = 0; i < tfJoinConcurrency; i++) {
      joinPromise.push(joinTestFlight(accountId, accountsSessionInfo[accountId], appId));
    }
  }
  return joinPromise;
}

async function checkAppIsOpen(accountId, sessionInfo, appId) {
  let allowJoin = false;
  let httpCode;
  return new Promise(async resolve => {
    if (tfJoinMode === 0) {
      const tfStatus = await getAppTestFlightHtml(appId);
      if (tfStatus === "NOT_FULL") {
        allowJoin = true;
        $.logger.info(`Ở chế độ nhẹ, ứng dụng ít được sử dụng [${appId}] sẽ cố gắng tham gia`);
      } else {
        allowJoin = false;
        $.logger.info(`Ở chế độ nhẹ, ứng dụng được điền đầy đủ [${appId}] sẽ không cố gắng tham gia.`);
      }
    } else if (tfJoinMode === 1) {
      [allowJoin, httpCode] = await getAppTestFlightJson(accountId, sessionInfo, appId);
      if (allowJoin === false) {
        $.logger.info(`Ở chế độ tiêu chuẩn, ứng dụng được điền đầy đủ [${appId}] sẽ không cố gắng tham gia.`);
      } else {
        $.logger.info(`Ở chế độ tiêu chuẩn, ứng dụng ít được sử dụng [${appId}] cố gắng tham gia`);
      }
    } else {
      $.logger.info(`Ở chế độ Bạo lực, nếu bạn không kiểm tra trạng thái của AppId và trực tiếp buộc yêu cầu tham gia ứng dụng [${appId}], tài khoản của bạn có thể bị cấm sử dụng.`);
    }
    $.logger.debug(`AppId [${appId}] Có cho phép tham gia hay không：${allowJoin}`);
    resolve(allowJoin === true ? {'app_id': appId, 'http_code': httpCode} : {});
  }).catch((err) => {
    $.logger.warning(`Đã xảy ra ngoại lệ khi kiểm tra xem ứng dụng ${appId} có mở hay không.\n${JSON.stringify(err)}`);
    return {};
  });
}

async function crowd() {
  try {
    // Nhận AccountId đã định cấu hình
    let allAccountIds = $.data.allSessionNames(tfSessionInfoKey);
    // Lấy AppID cần thêm
    let appIds = $.data.read(tfAppIdKey, "").split(";");
    appIds = appIds.filter(appId => {
      return appId !== ""
    });

    if (appIds.length === 0) {
      $.notification.post(`Không phát hiện thấy AppId hợp lệ, vui lòng kiểm tra cấu hình.`);
      return;
    }

    if (allAccountIds.length === 0) {
      $.notification.post(`Không tìm thấy thông tin tài khoản hợp lệ, vui lòng kiểm tra cấu hình.`);
      return;
    }

    // Nhận dữ liệu cơ bản cho từng tài khoản
    let accountsJoinedAppIds = $.data.read(tfJoinedAppIdKey, null, "", true);
    let accountsSessionInfo = $.data.read(tfSessionInfoKey, null, "", true);

    // Kiểm tra tính hợp lệ của session tài khoản
    const checkSessionTime = $.data.read(tfCheckSessionTimeKey, 0);
    const checkSessionTimeDiff = parseInt($.data.read(tfCheckSessionTimeDiffKey, 7200));
    const ts = Math.floor(Date.now() / 1000);
    if ((ts - checkSessionTime) >= checkSessionTimeDiff) {
      // Chọn ngẫu nhiên một AppId để kiểm tra
      const randomIndex = Math.floor(Math.random() * appIds.length);
      const appId = appIds[randomIndex];
      for (let accountId of allAccountIds) {
        let sessionInfo = accountsSessionInfo[accountId];
        // Chỉ kiểm tra các tài khoản hợp lệ
        if (sessionInfo["valid"] === true) {
          let [_, httpCode] = await getAppTestFlightJson(accountId, sessionInfo, appId);
          if (httpCode === 401) {
            // Sửa đổi session tài khoản thành không hợp lệ
            sessionInfo["valid"] = false;
            $.data.write(tfSessionInfoKey, sessionInfo, accountId);
            $.notification.post(`${accountId} session đã hết hạn, vui lòng đăng nhập lại`);
          } else if (httpCode === 404) {
            $.logger.warning(`Ngoại lệ kiểm tra tính hợp lệ của session, AppId được định cấu hình không chính xác`);
          } else if (httpCode === 200) {
            // Sửa đổi session tài khoản thành hợp lệ
            sessionInfo["valid"] = true;
            $.data.write(tfSessionInfoKey, sessionInfo, accountId);
            $.logger.info(`${accountId} Đã vượt qua kiểm tra tính hợp lệ của session`);
          }
        }
      }
      // Cập nhật thời gian kiểm tra
      $.data.write(tfCheckSessionTimeKey, ts);
    }

    let invalidAppIds = $.data.read(tfInvalidAppIdKey, []);

    // Xóa AppId được đánh giá là không hợp lệ
    appIds = appIds.filter((appId) => appId && !invalidAppIds.includes(appId));
    allAccountIds = allAccountIds.filter((accountId) => {
      return accountsSessionInfo[accountId]["valid"] === true
    });

    // Xác định xem có tài khoản nào được sử dụng cụ thể để kiểm tra xem có thể thêm TF hay không
    let checkAccountSessionInfo = blankSessionInfo;
    if (tfCheckAccountId && !allAccountIds.includes(tfCheckAccountId)) {
      // Xóa tài khoản séc
      $.logger.error(`Tài khoản được sử dụng để kiểm tra ${tfCheckAccountId} ，tồn tại nhưng tài khoản không được định cấu hình Session`);
      return;
    } else if (tfCheckAccountId) {
      // Lấy session được sử dụng để kiểm tra tài khoản sẵn có của TF từ session tài khoản
      checkAccountSessionInfo = accountsSessionInfo[tfCheckAccountId];
      $.logger.info(`Kiểm tra tính khả dụng của TF bằng tài khoản ${tfCheckAccountId} `);
    } else {
      // Không có tài khoản nào được chỉ định để kiểm tra, tài khoản được lấy ngẫu nhiên
      tfCheckAccountId = allAccountIds[Math.floor(Math.random() * allAccountIds.length)];
      $.logger.info(`Sử dụng ngẫu nhiên tài khoản ${tfCheckAccountId} để kiểm tra tính khả dụng của TF`);
      checkAccountSessionInfo = accountsSessionInfo[tfCheckAccountId];
    }

    let appJoinAccountIds = {};
    let openAppInfo = {}; // AppId có thể được thêm vào
    let checkAppPromise = [];
    // Nhận AppId bạn cần để thử tham gia lần này
    for (let appId of appIds) {
      const accountIds = allAccountIds.filter(accountId => (
            accountsJoinedAppIds[accountId] &&
            !accountsJoinedAppIds[accountId].includes(appId) &&
            !accountsJoinedAppIds[accountId].includes("*")
          ) ||
          !accountsJoinedAppIds[accountId]
      );
      if (accountIds.length > 0) {
        appJoinAccountIds[appId] = accountIds;
        checkAppPromise.push(checkAppIsOpen(tfCheckAccountId, checkAccountSessionInfo, appId));
      } else {
        $.logger.info(`Không có tài khoản nào để tham gia chương trình thử nghiệm beta của App [${appId}] \nTất cả các lần tham gia có thể đã hoàn tất hoặc session tài khoản đã hết hạn`);
      }
    }
    await Promise.all(checkAppPromise).then(appInfos => {
      for (let _appInfo of appInfos) {
        if (_appInfo && _appInfo["app_id"] && _appInfo["http_code"] === 200) {
          openAppInfo[_appInfo["app_id"]] = appJoinAccountIds[_appInfo["app_id"]];
        }
      }
    }).catch(e => {
      $.logger.error(`Kiểm tra xem App có thể thêm ngoại lệ hay không：${e}`);
    });

    // Cố gắng tham gia tất cả các AppId đang mở
    let joinPromise = [];
    for (let appId in openAppInfo) {
      if (appId !== "") {
        let temp = await startJoinAppTestFlight(openAppInfo[appId], accountsSessionInfo, appId)
        joinPromise = joinPromise.concat(temp);
      }
    }
    // Thực hiện để tham gia thử nghiệm beta
    await Promise.all(joinPromise).then(results => {
      let messages = {};
      for (let val of results) {
        if (val[0] === true) {
          const key = `${val[1]}-${val[3]}`
          if (!(key in messages)) {
            messages[key] = val;
          }
        }
      }
      // Gửi thông báo
      for (let key in messages) {
        $.notification.post(`${scriptName}-${messages[key][3]}`, `Đã tham gia thành công chương trình thử nghiệm beta của[${messages[key][2]}]`);
      }
    }).catch(err => {
      $.logger.error(err);
    })

  } catch (err) {
    $.logger.info(`Đã xảy ra ngoại lệ khi tự động tham gia TestFlight\n${err}`);
  }
}

async function loop() {
  let i = 0;
  while (true) {
    if (tfLoopCount > 0 && i >= tfLoopCount) {
      break;
    }
    i++;
    await new Promise(resolve => setTimeout(async () => {
      await crowd();
      resolve();
    }, 800));
  }
}

(async () => {
  let response = null;
  let url;
  let headers;
  let body;
  try {
    // $.notification.post(`khớp liên kết：${$.request.url}`);
    if ($.isResponse) {
      if (getFullAppIdRegex.test($.request.url)) {
        await autoAddAppId();
      } else if (getSessionRegex.test($.request.url)) {
        await getTFSessionInfo();
        response = await getAllAppData();
      } else {
        $.logger.warning(`Kết quả HTTP Request không mong đợi，URL：${$.request.url}\nVui lòng kiểm tra xem cấu hình có đúng không`);
      }
    } else if ($.isRequest) {
      if (modifyTFRequest.test($.request.url) ||
        modifySettingsTFRequest.test($.request.url) ||
        modifyInstallTFRequest.test($.request.url)) {
        [url, headers, body] = modifyRequest();
      } else {
        [url, headers, body] = [$.request.url, $.request.headers, $.request.body];
        $.logger.warning(`Kết quả HTTP Response không mong đợi，URL：${$.request.url}\nVui lòng kiểm tra xem cấu hình có đúng không`);
      }
    } else {
      $.logger.info(`Bắt đầu theo dõi trạng thái thử nghiệm ứng dụng  beta của bạn`);
      await loop();
    }
  } catch (err) {
    console.log("Lỗi\n" + err);
  } finally {
    if ($.isResponse) {
      if (response) {
        $.done(response);
      } else {
        $.done();
      }
    } else if ($.isRequest) {
      $.done({url, headers, body});
    } else {
      $.done();
    }
  }
})();

/**
 *
 * $$\      $$\                     $$\             $$$$$\  $$$$$$\         $$$$$$\
 * $$$\    $$$ |                    \__|            \__$$ |$$  __$$\       $$ ___$$\
 * $$$$\  $$$$ | $$$$$$\   $$$$$$\  $$\  $$$$$$$\      $$ |$$ /  \__|      \_/   $$ |
 * $$\$$\$$ $$ | \____$$\ $$  __$$\ $$ |$$  _____|     $$ |\$$$$$$\          $$$$$ /
 * $$ \$$$  $$ | $$$$$$$ |$$ /  $$ |$$ |$$ /     $$\   $$ | \____$$\         \___$$\
 * $$ |\$  /$$ |$$  __$$ |$$ |  $$ |$$ |$$ |     $$ |  $$ |$$\   $$ |      $$\   $$ |
 * $$ | \_/ $$ |\$$$$$$$ |\$$$$$$$ |$$ |\$$$$$$$\\$$$$$$  |\$$$$$$  |      \$$$$$$  |
 * \__|     \__| \_______| \____$$ |\__| \_______|\______/  \______/        \______/
 *                        $$\   $$ |
 *                        \$$$$$$  |
 *                         \______/
 *
 */
// @formatter:off
function MagicJS(scriptName="MagicJS",logLevel="INFO"){const MagicEnvironment=()=>{const isLoon=typeof $loon!=="undefined";const isQuanX=typeof $task!=="undefined";const isNode=typeof module!=="undefined";const isSurge=typeof $httpClient!=="undefined"&&!isLoon;const isStorm=typeof $storm!=="undefined";const isStash=typeof $environment!=="undefined"&&typeof $environment["stash-build"]!=="undefined";const isSurgeLike=isSurge||isLoon||isStorm||isStash;const isScriptable=typeof importModule!=="undefined";return{isLoon:isLoon,isQuanX:isQuanX,isNode:isNode,isSurge:isSurge,isStorm:isStorm,isStash:isStash,isSurgeLike:isSurgeLike,isScriptable:isScriptable,get name(){if(isLoon){return"Loon"}else if(isQuanX){return"QuantumultX"}else if(isNode){return"NodeJS"}else if(isSurge){return"Surge"}else if(isScriptable){return"Scriptable"}else{return"unknown"}},get build(){if(isSurge){return $environment["surge-build"]}else if(isStash){return $environment["stash-build"]}else if(isStorm){return $storm.buildVersion}},get language(){if(isSurge||isStash){return $environment["language"]}},get version(){if(isSurge){return $environment["surge-version"]}else if(isStash){return $environment["stash-version"]}else if(isStorm){return $storm.appVersion}else if(isNode){return process.version}},get system(){if(isSurge){return $environment["system"]}else if(isNode){return process.platform}},get systemVersion(){if(isStorm){return $storm.systemVersion}},get deviceName(){if(isStorm){return $storm.deviceName}}}};const MagicLogger=(scriptName,logLevel="INFO")=>{let _level=logLevel;const logLevels={SNIFFER:6,DEBUG:5,INFO:4,NOTIFY:3,WARNING:2,ERROR:1,CRITICAL:0,NONE:-1};const logEmoji={SNIFFER:"",DEBUG:"",INFO:"",NOTIFY:"",WARNING:"❗ ",ERROR:"❌ ",CRITICAL:"❌ ",NONE:""};const _log=(msg,level="INFO")=>{if(!(logLevels[_level]<logLevels[level.toUpperCase()]))console.log(`[${level}] [${scriptName}]\n${logEmoji[level.toUpperCase()]}${msg}\n`)};const setLevel=logLevel=>{_level=logLevel};return{getLevel:()=>{return _level},setLevel:setLevel,sniffer:msg=>{_log(msg,"SNIFFER")},debug:msg=>{_log(msg,"DEBUG")},info:msg=>{_log(msg,"INFO")},notify:msg=>{_log(msg,"NOTIFY")},warning:msg=>{_log(msg,"WARNING")},error:msg=>{_log(msg,"ERROR")},retry:msg=>{_log(msg,"RETRY")}}};return new class{constructor(scriptName,logLevel){this._startTime=Date.now();this.version="3.0.0";this.scriptName=scriptName;this.env=MagicEnvironment();this.logger=MagicLogger(scriptName,logLevel);this.http=typeof MagicHttp==="function"?MagicHttp(this.env,this.logger):undefined;this.data=typeof MagicData==="function"?MagicData(this.env,this.logger):undefined;this.notification=typeof MagicNotification==="function"?MagicNotification(this.scriptName,this.env,this.logger,this.http):undefined;this.utils=typeof MagicUtils==="function"?MagicUtils(this.env,this.logger):undefined;this.qinglong=typeof Magicqinglong==="function"?Magicqinglong(this.env,this.data,this.logger):undefined;if(typeof this.data!=="undefined"){let magicLoglevel=this.data.read("magic_loglevel");const barkUrl=this.data.read("magic_bark_url");if(magicLoglevel){this.logger.setLevel(magicLoglevel.toUpperCase())}if(barkUrl){this.notification.setBark(barkUrl)}}}get isRequest(){return typeof $request!=="undefined"&&typeof $response==="undefined"}get isResponse(){return typeof $response!=="undefined"}get isDebug(){return this.logger.level==="DEBUG"}get request(){return typeof $request!=="undefined"?$request:undefined}get response(){if(typeof $response!=="undefined"){if($response.hasOwnProperty("status"))$response["statusCode"]=$response["status"];if($response.hasOwnProperty("statusCode"))$response["status"]=$response["statusCode"];return $response}else{return undefined}}done=(value={})=>{this._endTime=Date.now();let span=(this._endTime-this._startTime)/1e3;this.logger.info(`SCRIPT COMPLETED: ${span} S.`);if(typeof $done!=="undefined"){$done(value)}}}(scriptName,logLevel)}
function MagicHttp(env,logger){const phoneUA="Mozilla/5.0 (iPhone; CPU iPhone OS 13_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.5 Mobile/15E148 Safari/604.1";const computerUA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36 Edg/84.0.522.59";let axiosInstance;if(env.isNode){const axios=require("axios");axiosInstance=axios.create()}class InterceptorManager{constructor(isRequest=true){this.handlers=[];this.isRequest=isRequest}use(fulfilled,rejected,options){if(typeof fulfilled==="function"){logger.debug(`Register fulfilled ${fulfilled.name}`)}if(typeof rejected==="function"){logger.debug(`Register rejected ${rejected.name}`)}this.handlers.push({fulfilled:fulfilled,rejected:rejected,synchronous:options&&typeof options.synchronous==="boolean"?options.synchronous:false,runWhen:options?options.runWhen:null});return this.handlers.length-1}eject(id){if(this.handlers[id]){this.handlers[id]=null}}forEach(fn){this.handlers.forEach(element=>{if(element!==null){fn(element)}})}}function paramsToQueryString(config){let _config={...config};if(!!_config.params){if(!env.isNode){let qs=Object.keys(_config.params).map(key=>{const encodeKey=encodeURIComponent(key);_config.url=_config.url.replace(new RegExp(`${key}=[^&]*`,"ig"),"");_config.url=_config.url.replace(new RegExp(`${encodeKey}=[^&]*`,"ig"),"");return`${encodeKey}=${encodeURIComponent(_config.params[key])}`}).join("&");if(_config.url.indexOf("?")<0)_config.url+="?";if(!/(&|\?)$/g.test(_config.url)){_config.url+="&"}_config.url+=qs;delete _config.params;logger.debug(`Params to QueryString: ${_config.url}`)}}return _config}const mergeConfig=(method,configOrUrl)=>{let config=typeof configOrUrl==="object"?{headers:{},...configOrUrl}:{url:configOrUrl,headers:{}};if(!config.method){config["method"]=method}config=paramsToQueryString(config);if(config["rewrite"]===true){if(env.isSurge){config.headers["X-Surge-Skip-Scripting"]=false;delete config["rewrite"]}else if(env.isQuanX){config["hints"]=false;delete config["rewrite"]}}if(env.isSurgeLike){const contentType=config.headers["content-type"]||config.headers["Content-Type"];if(config["method"]!=="GET"&&contentType&&contentType.indexOf("application/json")>=0&&config.body instanceof Array){config.body=JSON.stringify(config.body);logger.debug(`Convert Array object to String: ${config.body}`)}}else if(env.isQuanX){if(config.hasOwnProperty("body")&&typeof config["body"]!=="string")config["body"]=JSON.stringify(config["body"]);config["method"]=method}else if(env.isNode){if(method==="POST"||method==="PUT"||method==="PATCH"||method==="DELETE"){config.data=config.data||config.body}else if(method==="GET"){config.params=config.params||config.body}delete config.body}return config};const modifyResponse=(resp,config=null)=>{if(resp){let _resp={...resp,config:resp.config||config,status:resp.statusCode||resp.status,body:resp.body||resp.data,headers:resp.headers||resp.header};if(typeof _resp.body==="string"){try{_resp.body=JSON.parse(_resp.body)}catch{}}delete _resp.data;return _resp}else{return resp}};const convertHeadersToLowerCase=headers=>{return Object.keys(headers).reduce((acc,key)=>{acc[key.toLowerCase()]=headers[key];return acc},{})};const convertHeadersToCamelCase=headers=>{return Object.keys(headers).reduce((acc,key)=>{const newKey=key.split("-").map(word=>word[0].toUpperCase()+word.slice(1)).join("-");acc[newKey]=headers[key];return acc},{})};const raiseExceptionByStatusCode=(resp,config=null)=>{if(!!resp&&resp.status>=400){logger.debug(`Raise exception when status code is ${resp.status}`);return{name:"RequestException",message:`Request failed with status code ${resp.status}`,config:config||resp.config,response:resp}}};const interceptors={request:new InterceptorManager,response:new InterceptorManager(false)};let requestInterceptorChain=[];let responseInterceptorChain=[];let synchronousRequestInterceptors=true;function interceptConfig(config){config=paramsToQueryString(config);logger.debug(`HTTP ${config["method"].toUpperCase()}:\n${JSON.stringify(config)}`);return config}function interceptResponse(resp){try{resp=!!resp?modifyResponse(resp):resp;logger.sniffer(`HTTP ${resp.config["method"].toUpperCase()}:\n${JSON.stringify(resp.config)}\nSTATUS CODE:\n${resp.status}\nRESPONSE:\n${typeof resp.body==="object"?JSON.stringify(resp.body):resp.body}`);const err=raiseExceptionByStatusCode(resp);if(!!err){return Promise.reject(err)}return resp}catch(err){logger.error(err);return resp}}const registerInterceptors=config=>{try{requestInterceptorChain=[];responseInterceptorChain=[];interceptors.request.forEach(interceptor=>{if(typeof interceptor.runWhen==="function"&&interceptor.runWhen(config)===false){return}synchronousRequestInterceptors=synchronousRequestInterceptors&&interceptor.synchronous;requestInterceptorChain.unshift(interceptor.fulfilled,interceptor.rejected)});interceptors.response.forEach(interceptor=>{responseInterceptorChain.push(interceptor.fulfilled,interceptor.rejected)})}catch(err){logger.error(`Failed to register interceptors: ${err}.`)}};const request=(method,config)=>{let dispatchRequest;const _method=method.toUpperCase();config=mergeConfig(_method,config);if(env.isNode){dispatchRequest=axiosInstance}else{if(env.isSurgeLike){dispatchRequest=config=>{return new Promise((resolve,reject)=>{$httpClient[method.toLowerCase()](config,(err,resp,body)=>{if(err){let newErr={name:err.name||err,message:err.message||err,stack:err.stack||err,config:config,response:modifyResponse(resp)};reject(newErr)}else{resp.config=config;resp.body=body;resolve(resp)}})})}}else{dispatchRequest=config=>{return new Promise((resolve,reject)=>{$task.fetch(config).then(resp=>{resp=modifyResponse(resp,config);const err=raiseExceptionByStatusCode(resp,config);if(err){return Promise.reject(err)}resolve(resp)}).catch(err=>{let newErr={name:err.message||err.error,message:err.message||err.error,stack:err.error,config:config,response:!!err.response?modifyResponse(err.response):null};reject(newErr)})})}}}let promise;registerInterceptors(config);const defaultRequestInterceptors=[interceptConfig,undefined];const defaultResponseInterceptors=[interceptResponse,undefined];if(!synchronousRequestInterceptors){logger.debug("Interceptors are executed in asynchronous mode");let chain=[dispatchRequest,undefined];Array.prototype.unshift.apply(chain,defaultRequestInterceptors);Array.prototype.unshift.apply(chain,requestInterceptorChain);chain=chain.concat(defaultResponseInterceptors);chain=chain.concat(responseInterceptorChain);promise=Promise.resolve(config);while(chain.length){try{let onFulfilled=chain.shift();let onRejected=chain.shift();if(!env.isNode&&config["timeout"]&&onFulfilled===dispatchRequest){onFulfilled=requestTimeout}if(typeof onFulfilled==="function"){logger.debug(`Executing request fulfilled ${onFulfilled.name}`)}if(typeof onRejected==="function"){logger.debug(`Executing request rejected ${onRejected.name}`)}promise=promise.then(onFulfilled,onRejected)}catch(err){logger.error(`request exception: ${err}`)}}return promise}else{logger.debug("Interceptors are executed in synchronous mode");Array.prototype.unshift.apply(requestInterceptorChain,defaultRequestInterceptors);requestInterceptorChain=requestInterceptorChain.concat([interceptConfig,undefined]);while(requestInterceptorChain.length){let onFulfilled=requestInterceptorChain.shift();let onRejected=requestInterceptorChain.shift();try{if(typeof onFulfilled==="function"){logger.debug(`Executing request fulfilled ${onFulfilled.name}`)}config=onFulfilled(config)}catch(error){if(typeof onRejected==="function"){logger.debug(`Executing request rejected ${onRejected.name}`)}onRejected(error);break}}try{if(!env.isNode&&config["timeout"]){promise=requestTimeout(config)}else{promise=dispatchRequest(config)}}catch(err){return Promise.reject(err)}Array.prototype.unshift.apply(responseInterceptorChain,defaultResponseInterceptors);while(responseInterceptorChain.length){promise=promise.then(responseInterceptorChain.shift(),responseInterceptorChain.shift())}return promise}function requestTimeout(config){try{const timer=new Promise((_,reject)=>{setTimeout(()=>{let err={message:`timeout of ${config["timeout"]}ms exceeded.`,config:config};reject(err)},config["timeout"])});return Promise.race([dispatchRequest(config),timer])}catch(err){logger.error(`Request Timeout exception: ${err}.`)}}};return{request:request,interceptors:interceptors,convertHeadersToLowerCase:convertHeadersToLowerCase,convertHeadersToCamelCase:convertHeadersToCamelCase,modifyResponse:modifyResponse,get:configOrUrl=>{return request("GET",configOrUrl)},post:configOrUrl=>{return request("POST",configOrUrl)},put:configOrUrl=>{return request("PUT",configOrUrl)},patch:configOrUrl=>{return request("PATCH",configOrUrl)},delete:configOrUrl=>{return request("DELETE",configOrUrl)},head:configOrUrl=>{return request("HEAD",configOrUrl)},options:configOrUrl=>{return request("OPTIONS",configOrUrl)}}}
function MagicData(env,logger){let node={fs:undefined,data:{}};if(env.isNode){node.fs=require("fs");try{node.fs.accessSync("./magic.json",node.fs.constants.R_OK|node.fs.constants.W_OK)}catch(err){node.fs.writeFileSync("./magic.json","{}",{encoding:"utf8"})}node.data=require("./magic.json")}const defaultValueComparator=(oldVal,newVal)=>{if(typeof newVal==="object"){return false}else{return oldVal===newVal}};const _typeConvertor=val=>{if(val==="true"){return true}else if(val==="false"){return false}else if(typeof val==="undefined"){return null}else{return val}};const _valConvertor=(val,default_,session,read_no_session)=>{if(session){try{if(typeof val==="string")val=JSON.parse(val);if(val["magic_session"]===true){val=val[session]}else{val=null}}catch{val=null}}if(typeof val==="string"&&val!=="null"){try{val=JSON.parse(val)}catch{}}if(read_no_session===false&&!!val&&val["magic_session"]===true){val=null}if((val===null||typeof val==="undefined")&&default_!==null&&typeof default_!=="undefined"){val=default_}val=_typeConvertor(val);return val};const convertToObject=obj=>{if(typeof obj==="string"){let data={};try{data=JSON.parse(obj);const type=typeof data;if(type!=="object"||data instanceof Array||type==="bool"||data===null){data={}}}catch{}return data}else if(obj instanceof Array||obj===null||typeof obj==="undefined"||obj!==obj||typeof obj==="boolean"){return{}}else{return obj}};const readForNode=(key,default_=null,session="",read_no_session=false,externalData=null)=>{let data=externalData||node.data;if(!!data&&typeof data[key]!=="undefined"&&data[key]!==null){val=data[key]}else{val=!!session?{}:null}val=_valConvertor(val,default_,session,read_no_session);return val};const read=(key,default_=null,session="",read_no_session=false,externalData=null)=>{let val="";if(externalData||env.isNode){val=readForNode(key,default_,session,read_no_session,externalData)}else{if(env.isSurgeLike){val=$persistentStore.read(key)}else if(env.isQuanX){val=$prefs.valueForKey(key)}val=_valConvertor(val,default_,session,read_no_session)}logger.debug(`READ DATA [${key}]${!!session?`[${session}]`:""} <${typeof val}>\n${JSON.stringify(val)}`);return val};const writeForNode=(key,val,session="",externalData=null)=>{let data=externalData||node.data;data=convertToObject(data);if(!!session){let obj=convertToObject(data[key]);obj["magic_session"]=true;obj[session]=val;data[key]=obj}else{data[key]=val}if(externalData!==null){externalData=data}return data};const write=(key,val,session="",externalData=null)=>{if(typeof val==="undefined"||val!==val){return false}if(!env.isNode&&(typeof val==="boolean"||typeof val==="number")){val=String(val)}let data="";if(externalData||env.isNode){data=writeForNode(key,val,session,externalData)}else{if(!session){data=val}else{if(env.isSurgeLike){data=!!$persistentStore.read(key)?$persistentStore.read(key):data}else if(env.isQuanX){data=!!$prefs.valueForKey(key)?$prefs.valueForKey(key):data}data=convertToObject(data);data["magic_session"]=true;data[session]=val}}if(!!data&&typeof data==="object"){data=JSON.stringify(data,null,4)}logger.debug(`WRITE DATA [${key}]${session?`[${session}]`:""} <${typeof val}>\n${JSON.stringify(val)}`);if(!externalData){if(env.isSurgeLike){return $persistentStore.write(data,key)}else if(env.isQuanX){return $prefs.setValueForKey(data,key)}else if(env.isNode){try{node.fs.writeFileSync("./magic.json",data);return true}catch(err){logger.error(err);return false}}}return true};const update=(key,val,session,comparator=defaultValueComparator,externalData=null)=>{val=_typeConvertor(val);const oldValue=read(key,null,session,false,externalData);if(comparator(oldValue,val)===true){return false}else{const result=write(key,val,session,externalData);let newVal=read(key,null,session,false,externalData);if(comparator===defaultValueComparator&&typeof newVal==="object"){return result}return comparator(val,newVal)}};const delForNode=(key,session,externalData)=>{let data=externalData||node.data;data=convertToObject(data);if(!!session){obj=convertToObject(data[key]);delete obj[session];data[key]=obj}else{delete data[key]}if(!!externalData){externalData=data}return data};const del=(key,session="",externalData=null)=>{let data={};if(externalData||env.isNode){data=delForNode(key,session,externalData);if(!externalData){node.fs.writeFileSync("./magic.json",JSON.stringify(data,null,4))}else{externalData=data}}else{if(!session){if(env.isStorm){return $persistentStore.remove(key)}else if(env.isSurgeLike){return $persistentStore.write(null,key)}else if(env.isQuanX){return $prefs.removeValueForKey(key)}}else{if(env.isSurgeLike){data=$persistentStore.read(key)}else if(env.isQuanX){data=$prefs.valueForKey(key)}data=convertToObject(data);delete data[session];const json=JSON.stringify(data,null,4);write(key,json)}}logger.debug(`DELETE KEY [${key}]${!!session?`[${session}]`:""}`)};const allSessionNames=(key,externalData=null)=>{let _sessions=[];let data=read(key,null,null,true,externalData);data=convertToObject(data);if(data["magic_session"]!==true){_sessions=[]}else{_sessions=Object.keys(data).filter(key=>key!=="magic_session")}logger.debug(`READ ALL SESSIONS [${key}] <${typeof _sessions}>\n${JSON.stringify(_sessions,null,4)}`);return _sessions};const allSessions=(key,externalData=null)=>{let _sessions={};let data=read(key,null,null,true,externalData);data=convertToObject(data);if(data["magic_session"]===true){_sessions={...data};delete _sessions["magic_session"]}logger.debug(`READ ALL SESSIONS [${key}] <${typeof _sessions}>\n${JSON.stringify(_sessions,null,4)}`);return _sessions};return{read:read,write:write,del:del,update:update,allSessions:allSessions,allSessionNames:allSessionNames,defaultValueComparator:defaultValueComparator,convertToObject:convertToObject}}
function MagicNotification(scriptName,env,logger,http){let _barkUrl=null;let _barkKey=null;const setBark=url=>{try{let _url=url.replace(/\/+$/g,"");_barkUrl=`${/^https?:\/\/([^/]*)/.exec(_url)[0]}/push`;_barkKey=/\/([^\/]+)\/?$/.exec(_url)[1]}catch(ex){logger.error(`Bark url error: ${ex}.`)}};function post(title=scriptName,subTitle="",body="",opts=""){const _adaptOpts=_opts=>{try{let newOpts={};if(typeof _opts==="string"){if(env.isLoon)newOpts={openUrl:_opts};else if(env.isQuanX)newOpts={"open-url":_opts};else if(env.isSurge)newOpts={url:_opts}}else if(typeof _opts==="object"){if(env.isLoon){newOpts["openUrl"]=!!_opts["open-url"]?_opts["open-url"]:"";newOpts["mediaUrl"]=!!_opts["media-url"]?_opts["media-url"]:""}else if(env.isQuanX){newOpts=!!_opts["open-url"]||!!_opts["media-url"]?_opts:{}}else if(env.isSurge){let openUrl=_opts["open-url"]||_opts["openUrl"];newOpts=openUrl?{url:openUrl}:{}}}return newOpts}catch(err){logger.error(`通知选项转换失败${err}`)}return _opts};opts=_adaptOpts(opts);if(arguments.length===1){title=scriptName;subTitle="",body=arguments[0]}logger.notify(`title:${title}\nsubTitle:${subTitle}\nbody:${body}\noptions:${typeof opts==="object"?JSON.stringify(opts):opts}`);if(env.isSurge){$notification.post(title,subTitle,body,opts)}else if(env.isLoon){if(!!opts)$notification.post(title,subTitle,body,opts);else $notification.post(title,subTitle,body)}else if(env.isQuanX){$notify(title,subTitle,body,opts)}if(_barkUrl&&_barkKey){bark(title,subTitle,body)}}function debug(title=scriptName,subTitle="",body="",opts=""){if(logger.getLevel()==="DEBUG"){if(arguments.length===1){title=scriptName;subTitle="";body=arguments[0]}this.post(title,subTitle,body,opts)}}function bark(title=scriptName,subTitle="",body="",opts=""){if(typeof http==="undefined"||typeof http.post==="undefined"){throw"Bark notification needs to import MagicHttp module."}let options={url:_barkUrl,headers:{"content-type":"application/json; charset=utf-8"},body:{title:title,body:subTitle?`${subTitle}\n${body}`:body,device_key:_barkKey}};http.post(options).catch(ex=>{logger.error(`Bark notify error: ${ex}`)})}return{post:post,debug:debug,bark:bark,setBark:setBark}}
function MagicUtils(env,logger){const retry=(fn,retries=5,interval=0,callback=null)=>{return(...args)=>{return new Promise((resolve,reject)=>{function _retry(...args){Promise.resolve().then(()=>fn.apply(this,args)).then(result=>{if(typeof callback==="function"){Promise.resolve().then(()=>callback(result)).then(()=>{resolve(result)}).catch(ex=>{if(retries>=1){if(interval>0)setTimeout(()=>_retry.apply(this,args),interval);else _retry.apply(this,args)}else{reject(ex)}retries--})}else{resolve(result)}}).catch(ex=>{logger.error(ex);if(retries>=1&&interval>0){setTimeout(()=>_retry.apply(this,args),interval)}else if(retries>=1){_retry.apply(this,args)}else{reject(ex)}retries--})}_retry.apply(this,args)})}};const formatTime=(time,fmt="yyyy-MM-dd hh:mm:ss")=>{let o={"M+":time.getMonth()+1,"d+":time.getDate(),"h+":time.getHours(),"m+":time.getMinutes(),"s+":time.getSeconds(),"q+":Math.floor((time.getMonth()+3)/3),S:time.getMilliseconds()};if(/(y+)/.test(fmt))fmt=fmt.replace(RegExp.$1,(time.getFullYear()+"").substr(4-RegExp.$1.length));for(let k in o)if(new RegExp("("+k+")").test(fmt))fmt=fmt.replace(RegExp.$1,RegExp.$1.length===1?o[k]:("00"+o[k]).substr((""+o[k]).length));return fmt};const now=()=>{return formatTime(new Date,"yyyy-MM-dd hh:mm:ss")};const today=()=>{return formatTime(new Date,"yyyy-MM-dd")};const sleep=time=>{return new Promise(resolve=>setTimeout(resolve,time))};const assert=(val,msg=null)=>{if(env.isNode){const _assert=require("assert");if(msg)_assert(val,msg);else _assert(val)}else{if(val!==true){let err=`AssertionError: ${msg||"The expression evaluated to a falsy value."}`;logger.error(err)}}};return{retry:retry,formatTime:formatTime,now:now,today:today,sleep:sleep,assert:assert}}
function Magicqinglong(env,data,logger){let qlUrl="";let qlName="";let qlClient="";let qlSecret="";let qlPwd="";let qlToken="";const magicJsonFileName="magic.json";const timeout=3e3;const http=(()=>MagicHttp(env,logger))();const init=(url,clientId,clientSecret,username,password)=>{qlUrl=url;qlClient=clientId;qlSecret=clientSecret;qlName=username;qlPwd=password};function readqinglongConfig(config){qlUrl=qlUrl||data.read("magic_qlurl");qlToken=qlToken||data.read("magic_qltoken");logger.debug(`qinglong url: ${qlUrl}\nqinglong token: ${qlToken}`);return config}function setBaseUrlAndTimeout(config){if(!qlUrl){qlUrl=data.read("magic_qlurl")}if(config.url.indexOf(qlUrl)<0){config.url=`${qlUrl}${config.url}`}return{...config,timeout:timeout}}function setTimestamp(config){config.params={...config.params,t:Date.now()};return config}async function setAuthorization(config){qlToken=qlToken||data.read("magic_qltoken","");if(!qlToken){await getToken()}config.headers["authorization"]=`Bearer ${qlToken}`;return config}function switchClientMode(config){qlClient=qlClient||data.read("magic_qlclient");if(!!qlClient){config.url=config.url.replace("/api/","/open/")}return config}async function refreshToken(error){try{const message=error.message||error.error||JSON.stringify(error);if((message.indexOf("NSURLErrorDomain")>=0&&message.indexOf("-1012")>=0||!!error.response&&error.response.status===401)&&!!error.config&&error.config.refreshToken!==true){logger.warning(`qinglong Panel token has expired`);logger.info("Refreshing the qinglong Panel token");await getToken();error.config["refreshToken"]=true;logger.info("Call the previous method again");return await http.request(error.config.method,error.config)}else{return Promise.reject(error)}}catch(ex){return Promise.reject(ex)}}http.interceptors.request.use(setBaseUrlAndTimeout,undefined);http.interceptors.request.use(switchClientMode,undefined,{runWhen:config=>{return config.url.indexOf("api/user/login")<0&&config.url.indexOf("open/auth/token")<0}});http.interceptors.request.use(setAuthorization,undefined,{runWhen:config=>{return config.url.indexOf("api/user/login")<0&&config.url.indexOf("open/auth/token")<0}});http.interceptors.request.use(setTimestamp,undefined,{runWhen:config=>{return config.url.indexOf("open/auth/token")<0}});http.interceptors.request.use(readqinglongConfig,undefined);http.interceptors.response.use(undefined,refreshToken);async function getToken(){qlClient=qlClient||data.read("magic_qlclient");qlSecret=qlSecret||data.read("magic_qlsecrt");qlName=qlName||data.read("magic_qlname");qlPwd=qlPwd||data.read("magic_qlpwd");if(qlUrl&&qlClient&&qlSecret){logger.info("Get token from qinglong Panel");await http.get({url:`/open/auth/token`,headers:{"content-type":"application/json"},params:{client_id:qlClient,client_secret:qlSecret}}).then(resp=>{if(Object.keys(resp.body).length>0&&resp.body.data&&resp.body.data.token){logger.info("Successfully logged in to qinglong Panel");qlToken=resp.body.data.token;data.write("magic_qltoken",qlToken)}else{throw new Error("Get qinglong Panel token failed.")}}).catch(err=>{logger.error(`Error logging in to qinglong Panel.\n${err.message||err}`)})}else if(qlUrl&&qlName&&qlPwd){await http.post({url:`/api/user/login`,headers:{"content-type":"application/json"},body:{username:qlName,password:qlPwd}}).then(resp=>{logger.info("Successfully logged in to qinglong Panel");qlToken=resp.body.data.token;data.write("magic_qltoken",qlToken)}).catch(err=>{logger.error(`Error logging in to qinglong Panel.\n${err.message||err}`)})}return qlToken}async function setEnv(name,value,id=null){qlUrl=qlUrl||data.read("magic_qlurl");if(id===null){let envIds=await setEnvs([{name:name,value:value}]);if(!!envIds&&envIds.length===1){return envIds[0]}}else{await http.put({url:`/api/envs`,headers:{"content-type":"application/json"},body:{name:name,value:value,id:id}}).then(resp=>{if(resp.body.code===200){logger.debug(`qinglong UPDATE ENV ${name} <${typeof value}> (${id})\n${JSON.stringify(value)}`);return true}else{logger.error(`Error adding environment variable from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error adding environment variable from qinglong Panel.\n${err.message||err}`);return false})}}async function setEnvs(envs){let envIds=[];await http.post({url:`/api/envs`,headers:{"content-type":"application/json"},body:envs}).then(resp=>{if(resp.body.code===200){resp.body.data.forEach(element=>{logger.debug(`qinglong ADD ENV ${element.name} <${typeof element.value}> (${element.id})\n${JSON.stringify(element)}`);envIds.push(element.id)})}else{logger.error(`Error adding environments variable from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error adding environments variable from qinglong Panel.\n${err.message||err}`)});return envIds}async function delEnvs(ids){return await http.delete({url:`/api/envs`,headers:{accept:"application/json","accept-language":"zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",connection:"keep-alive","content-type":"application/json;charset=UTF-8","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36 Edg/102.0.1245.30"},body:ids}).then(resp=>{if(resp.body.code===200){logger.debug(`qinglong DELETE ENV IDS: ${ids}`);return true}else{logger.error(`Error deleting environments variable from qinglong Panel.\n${JSON.stringify(resp)}`);return false}}).catch(err=>{logger.error(`Error deleting environments variable from qinglong Panel.\n${err.message||err}`)})}async function getEnvs(name=null,searchValue="",retired=0){let envs=[];await http.get({url:`/api/envs`,headers:{"content-type":"application/json"},params:{searchValue:searchValue}}).then(resp=>{if(resp.body.code===200){const allEnvs=resp.body.data;if(!!name){let _envs=[];for(const env of allEnvs){if(env.name===name){envs.push(env)}}envs=_envs}envs=allEnvs}else{throw new Error(`Error reading environment variable from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{throw new Error(`Error reading environments variable from qinglong Panel.\n${err.message||err}`)});return envs}async function getEnv(id){let env=null;const allEnvs=await getEnvs();for(const _env of allEnvs){if(_env.id===id){env=_env;break}}return env}async function disableEnvs(ids){let result=false;await http.put({url:`/api/envs/disable`,headers:{accept:"application/json","accept-Language":"zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",connection:"keep-alive","content-type":"application/json;charset=UTF-8","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36 Edg/102.0.1245.30"},body:ids}).then(resp=>{if(resp.body.code===200){logger.debug(`qinglong DISABLED ENV IDS: ${ids}`);result=true}else{logger.error(`Error disabling environments variable from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error disabling environments variable from qinglong Panel.\n${err.message||err}`)});return result}async function enableEnvs(ids){let result=false;await http.put({url:`/api/envs/enable`,headers:{accept:"application/json","accept-language":"zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",connection:"keep-alive","content-type":"application/json;charset=UTF-8","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.63 Safari/537.36 Edg/102.0.1245.30"},body:ids}).then(resp=>{if(resp.body.code===200){logger.debug(`qinglong ENABLED ENV IDS: ${ids}`);result=true}else{logger.error(`Error enabling environments variable from Qilong panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error enabling environments variable from Qilong panel.\n${err.message||err}`)});return result}async function addScript(name,path="",content=""){let result=false;await http.post({url:`/api/scripts`,headers:{"content-type":"application/json"},body:{filename:name,path:path,content:content}}).then(resp=>{if(resp.body.code===200){result=true}else{logger.error(`Error reading data from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error reading data from qinglong Panel.\n${err.message||err}`)});return result}async function getScript(name,path=""){let content="";await http.get({url:`/api/scripts/${name}`,params:{path:path}}).then(resp=>{if(resp.body.code===200){content=resp.body.data}else{throw new Error(`Error reading data from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{throw new Error(`Error reading data from qinglong Panel.\n${err.message||err}`)});return content}async function editScript(name,path="",content=""){let result=false;await http.put({url:`/api/scripts`,headers:{"content-type":"application/json"},body:{filename:name,path:path,content:content}}).then(resp=>{if(resp.body.code===200){result=true}else{logger.error(`Error reading data from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error reading data from qinglong Panel.\n${err.message||err}`)});return result}async function delScript(name,path=""){let result=false;await http.delete({url:`/api/scripts`,headers:{"content-type":"application/json"},body:{filename:name,path:path}}).then(resp=>{if(resp.body.code===200){result=true}else{logger.error(`Error reading data from qinglong Panel.\n${JSON.stringify(resp)}`)}}).catch(err=>{logger.error(`Error reading data from qinglong Panel.\n${err.message||err}`)});return result}async function write(key,val,session=""){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);let writeResult=data.write(key,val,session,qlData);qlContent=JSON.stringify(qlData,null,4);let editResult=await editScript(magicJsonFileName,"",qlContent);return editResult&&writeResult}async function batchWrite(...args){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);for(let arg of args){data.write(arg[0],arg[1],typeof arg[2]!=="undefined"?arg[2]:"",qlData)}qlContent=JSON.stringify(qlData,null,4);return await editScript(magicJsonFileName,"",qlContent)}async function update(key,val,session,comparator=data.defaultValueComparator){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);const updateResult=data.update(key,val,session,comparator,qlData);let editScriptResult=false;if(updateResult===true){qlContent=JSON.stringify(qlData,null,4);editScriptResult=await editScript(magicJsonFileName,"",qlContent)}return updateResult&&editScriptResult}async function batchUpdate(...args){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);for(let arg of args){data.update(arg[0],arg[1],typeof arg[2]!=="undefined"?arg[2]:"",typeof arg[3]!=="undefined"?arg["comparator"]:data.defaultValueComparator,qlData)}qlContent=JSON.stringify(qlData,null,4);return await editScript(magicJsonFileName,"",qlContent)}async function read(key,val,session="",read_no_session=false){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);return data.read(key,val,session,read_no_session,qlData)}async function batchRead(...args){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);let results=[];for(let arg of args){const result=data.read(arg[0],arg[1],typeof arg[2]!=="undefined"?arg[2]:"",typeof arg[3]==="boolean"?arg[3]:false,qlData);results.push(result)}return results}async function del(key,session=""){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);const delResult=data.del(key,session,qlData);qlContent=JSON.stringify(qlData,null,4);const editResult=await editScript(magicJsonFileName,"",qlContent);return delResult&&editResult}async function batchDel(...args){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);for(let arg of args){data.del(arg[0],typeof arg[1]!=="undefined"?arg[1]:"",qlData)}qlContent=JSON.stringify(qlData,null,4);return await editScript(magicJsonFileName,"",qlContent)}async function allSessionNames(key){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);return data.allSessionNames(key,qlData)}async function allSessions(key){let qlContent=await getScript(magicJsonFileName,"");let qlData=data.convertToObject(qlContent);return data.allSessions(key,qlData)}return{url:qlUrl||data.read("magic_qlurl"),init:init,getToken:getToken,setEnv:setEnv,setEnvs:setEnvs,getEnv:getEnv,getEnvs:getEnvs,delEnvs:delEnvs,disableEnvs:disableEnvs,enableEnvs:enableEnvs,addScript:addScript,getScript:getScript,editScript:editScript,delScript:delScript,write:write,read:read,del:del,update:update,batchWrite:batchWrite,batchRead:batchRead,batchUpdate:batchUpdate,batchDel:batchDel,allSessions:allSessions,allSessionNames:allSessionNames}}
// @formatter:on
