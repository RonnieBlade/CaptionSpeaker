let speechSynthesis = window.speechSynthesis;
let TARGET_ID = "CaptionSpeakerData";
let PLAYER_RESPONSE_ATTRIBUTE_NAME = "ytplayer.config.args.raw_player_response";
var prevSpeakTime = "";
var playLocale = window.navigator.language;
var captionData = {};
var isEnabled = false;
var isStopIfNewSpeech = false;
var isDisableSpeechIfSameLocaleVideo = false;
var isDisableSpeechIfChaptionDisabled = false;
var videoLengthSeconds = -1;
var guessedOriginalCaptionLanguage = undefined;

var voicePitch = 1.0;
var voiceRate = 1.6;
var voiceVolume = 1.0;
var voiceVoice = undefined;

/* // こちらは Manifest V3 対応時に取り出し方を変えるので必要なくなります
// Youtubeのscript側で設定している ytplayer.config.args.player_response (中身は JSON文字列) を、bodyに<script></script> を埋め込む形で取り出します。
let INJECT_SCRIPT = `
(function(){
  let raw_player_response = ytplayer?.config?.args?.raw_player_response;
  let player_response = ytplayer?.config?.args?.player_response;
  if(player_response){
    document.getElementById("${TARGET_ID}").setAttribute("${PLAYER_RESPONSE_ATTRIBUTE_NAME}", player_response);
    return;
  }
  if(raw_player_response){
    document.getElementById("${TARGET_ID}").setAttribute("${PLAYER_RESPONSE_ATTRIBUTE_NAME}", JSON.stringify(raw_player_response))
  }
})();
`;
*/
/* // こちらは Manifest V3 対応時に取り出し方を変えるので必要なくなります
function RemoveInjectElement(idText){
  document.getElementById(idText)?.remove();
}

function InjectScript(scriptText, idText){
  let element = document.createElement('script');
  element.textContent = scriptText;
  if(idText){
    element.id = idText;
  }
  document.body.appendChild(element);
}
*/

// 怪しく var ytInitialPlayerResponse = ... という記述のある script の文字列を拾い出して、そこから ytplayer...player_response の値を抽出します。
// 元々は ytplayer?.config?.args?.raw_player_response といったあたりに保存されている値を読み出していましたが、content_script側で <script>...</script> を document に突っ込んで取り出す、という荒業をしていて、これは content security policy にひっかかるような行為なわけで、見える形で <script> に埋め込まれているものがあるのなら、という事でこちらから取り出す事にします。しかしこの <script> は以前はなかったと思うんだけれど、そのうちまたなくなったりしないか不安だなぁ。(´・ω・`)
// なお、この取り出し方はかなーり怪しいので、少しでもフォーマットが書き換わると動かなくなる(元々 JavaScript の source を JSON.parse() しているのでちょっとでもゴミが入ると駄目な)ので、怪しい橋を渡っている感じで凄く怖いです。
function GetYtInitalPlayerResponse(){
  const element = document.evaluate("//body/script[@nonce and contains(text(),'var ytInitialPlayerResponse')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0);
  //console.log("ytInitialPlayerResponse element:", element, element.textContent);
  const ytInitialPlayerResponseString = element.textContent.replace(/;var meta =.*/, '').replace(/^var ytInitialPlayerResponse = /,'');
  try {
    const ytInitialPlayerResponse = JSON.parse(ytInitialPlayerResponseString);
    return ytInitialPlayerResponse;
  }catch(e){
    console.log("GetYtInitialPlayerResponse decode error:", ytInitialPlayerResponseString);
  }
  return undefined;
}

// ytplayer.config.args.player_response の中に含まれている字幕の情報から
// 対象のロケールにおける(最適な)字幕データを取得するためのURLを生成します。
function GetCaptionDataUrl(){
  /* // こちらは Manifest V3 対応時に取り出し方を変えるので必要なくなります
  let element = document.getElementById(TARGET_ID);
  if(!element){ console.log("can not get element"); return; }
  let player_response = element.getAttribute(PLAYER_RESPONSE_ATTRIBUTE_NAME);
  if(!player_response){ console.log("can not get player_response", element); return; }
  var player_response_obj;
  try {
    player_response_obj = JSON.parse(player_response);
  }catch(e){
    console.log("player_response JSON.parse() error:", e);
    return;
  }
  //console.log("player_response", player_response_obj);*/

  const player_response_obj = GetYtInitalPlayerResponse();
  // GetCaptionDataUrl() という関数なのに、ここでは怪しく player_response を読み込んでいます。('A`)
  let lengthSeconds = VideoLengthSecondsFromPlayerResponse(player_response_obj);
  if(lengthSeconds > 0){ videoLengthSeconds = lengthSeconds; }
  guessedOriginalCaptionLanguage = GuessVideoAutoTransrateOriginalLanguage(player_response_obj);
  //console.log("guessedOriginalCaptionLanguage", guessedOriginalCaptionLanguage);

  // 用意されている字幕でターゲットとなるロケールの物があればそれを使います
  let captionTracks = player_response_obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let playLocaleCaptionBaseUrl = captionTracks?.filter(obj => obj?.languageCode == playLocale)[0]?.baseUrl;
  if(playLocaleCaptionBaseUrl){
    return playLocaleCaptionBaseUrl + "&fmt=json3";
  }

  // なさそうなら、captionTracks の先頭の物から対象のロケールに書き換えた物を取得するようにします。
  if(!captionTracks){ console.log("can not get captionTracks", player_response_obj); return; }
  let baseUrl = captionTracks[0]?.baseUrl;
  if(!baseUrl){ console.log("can not get baseUrl", player_response_obj); return; }
  let origUrl = baseUrl.replace(/,/g, "%2C");
  return origUrl + "&fmt=json3&xorb=2&xobt=3&xovt=3&tlang=" + playLocale;
}

function FetchCaptionData(){
  let url = GetCaptionDataUrl();
  fetch(url)
  .then((response)=>{
    return response?.json();
  }).then((json)=>{
    if(!json){return;}
    if(guessedOriginalCaptionLanguage == playLocale && isDisableSpeechIfSameLocaleVideo){return;}
    console.log("FetchCaptionData() pass isDisableSpeechIfSameLocaleVideo check", isDisableSpeechIfSameLocaleVideo, guessedOriginalCaptionLanguage, playLocale);
    captionData = CaptionDataToTimeDict(json);
    console.log("captionData update:", captionData);
  }).catch(err=>{console.log("Fetch got error:", err);});
}

function FormatTimeFromMillisecond(millisecond){
  let totalSecond = millisecond / 1000;
  let hour = parseInt((totalSecond / 60 / 60) % 24);
  var minute = parseInt((totalSecond / 60) % 60);
  var second = parseInt((totalSecond) % 60);
  if(second < 10){ second = "0" + second; }
  if(hour > 0 && minute < 10){ minute = "0" + minute; }
  if(hour > 0){
    return hour + ":" + minute + ":" + second;
  }
  return minute + ":" + second;
}

function CheckCaptionIsDisplaying(){
  return document.evaluate("//button[contains(@class,'ytp-subtitles-button')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0)?.getAttribute('aria-pressed') == "true";
}

// player_response から .microformat.playerMicroformatRenderer.lengthSeconds を取り出します
function VideoLengthSecondsFromPlayerResponse(player_response){
  return player_response?.videoDetails?.lengthSeconds;
}

function GuessVideoAutoTransrateOriginalLanguage(player_response){
  let captionTracks = player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let autoDetectedCaption = captionTracks?.filter(x=> x["kind"] == "asr");
  if(autoDetectedCaption){
    return autoDetectedCaption[0]?.languageCode;
  }
  if(captionTracks){
    return captionTracks[0]?.languageCode;
  }
  return undefined;
}

// 字幕のデータを後で使いやすいように加工しておきます。
function CaptionDataToTimeDict(captionData){
  let events = captionData?.events;
  if(!events){ console.log("CaptionDataToTimeDict(): error. events not found"); return; }
  let captionArray = events.map((obj)=>{
    let tStartMs = obj?.tStartMs;
    // 表示上は分割して表示されるのですが、最低1文字づつで分割されており
    // そのまま読み上げるとぶつ切りで聞くに堪えない事になるため、
    // セグメント(表示上は一行分になるもの)についてはひとかたまりに加工しておきます。
    let segment = obj?.segs?.reduce((acc,current)=>{
      let text = current?.utf8;
      if(text){
        return acc + text;
      }
      return acc;
    }, '');
    return {"tStartMs": tStartMs, "segment": segment, "time": FormatTimeFromMillisecond(tStartMs)};
  }).filter((obj)=>{
    // 発話という意味では中身が空の物は意味がないのでここで消しておきます
    let segment = obj?.segment;
    if(segment?.length > 0 && segment.replace(/[\s\r\n]*/g, "").length > 0){
      return true;
    }
    return false;
  });
  var timeDict = {};
  captionArray.map(obj=>timeDict[obj.time]=obj);
  return timeDict;
}

function UpdatePlayLocale(locale){
  let l = locale?.replace(/-.*$/, '');
  if(l?.length > 0 && playLocale != l){
    playLocale = l;
    // locale が変わっていたなら、今読み込まれている字幕データは破棄して新しく読み直さないと謎の発話を続ける事になります。
    captionData = {};
    UpdateCaptionData();
  }
}

function LoadVoiceSettings(){
  chrome.storage.sync.get(["lang", "voice", "pitch", "rate", "volume"], (result)=>{
    let lang = result.lang;
    let voiceName = result.voice;
    let voiceList = speechSynthesis.getVoices();
    for(voice of voiceList){
      if(voice.lang == lang && voice.name == voiceName){
        voiceVoice = voice;
        UpdatePlayLocale(lang);
      }
    }
    let pitch = result.pitch;
    if(pitch){
      voicePitch = pitch;
    }
    let rate = result.rate;
    if(rate){
      voiceRate = rate;
    }
    let volume = result.volume;
    if(volume){
      voiceVolume = volume;
    }
  });
}

function AddSpeechQueue(text){
  let utt = new SpeechSynthesisUtterance(text);
  if(voiceVoice){
    utt.voice = voiceVoice;
    utt.lang = utt.voice.lang;
  }
  utt.pitch = voicePitch;
  utt.rate = voiceRate;
  utt.volume = voiceVolume;
  utt.onerror = function(event){console.log("SpeechSynthesisUtterance Event onError", event);};
  if(isStopIfNewSpeech){
    console.log("isStopIfNewSpeech is true");
    speechSynthesis.cancel();
  }
  speechSynthesis.speak(utt);
}

// 単純に秒単位で時間を確認して、前回読み上げた時間と変わっているのなら発話する、という事をします。
function CheckAndSpeech(currentTimeText){
  if(!currentTimeText){ console.log("currentTimeText is nil"); return;}
  if(currentTimeText == prevSpeakTime){ return;}
  if(isDisableSpeechIfChaptionDisabled && !CheckCaptionIsDisplaying()){ return; }
  let caption = captionData[currentTimeText];
  if(caption){
    prevSpeakTime = currentTimeText;
    AddSpeechQueue(caption.segment);
    return;
  }
  //console.log("no caption:", currentTimeText);
}

function IsValidVideoDuration(duration, captionData){
  if(videoLengthSeconds > 0){
    return Math.abs(videoLengthSeconds - duration) < 4;
  }
  var maxMillisecond = 0;
  for(let key in captionData){
    let tStartMs = captionData[key]?.tStartMs;
    if(tStartMs > maxMillisecond){
      maxMillisecond = tStartMs;
    }
  }
  return duration >= maxMillisecond / 1000;
}

// 再生位置を video object の .currentTime から取得します
function CheckVideoCurrentTime(){
  if(!isEnabled){return;}
  let videoElement = document.evaluate("//video[contains(@class,'html5-main-video')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)?.snapshotItem(0);
  if(!videoElement){return;}
  let currentTime = videoElement.currentTime;
  let duration = videoElement.duration;
  if(!IsValidVideoDuration(duration, captionData)){return;}
  let timeText = FormatTimeFromMillisecond(currentTime * 1000);
  CheckAndSpeech(timeText);
}

var WatchYtplayerLoadForCaptionData_TTL = 20;
function WatchYtplayerLoadForCaptionData() {
  WatchYtplayerLoadForCaptionData_TTL -= 1;
  if(WatchYtplayerLoadForCaptionData_TTL < 0) { return; }
  if(Object.keys(captionData).length > 0) { return; }
  UpdateCaptionData();
  setTimeout(WatchYtplayerLoadForCaptionData, 500);
}

function UpdateCaptionData(){
  //RemoveInjectElement(TARGET_ID);
  // Youtubeのscriptが設定したデータを読み取るために body に <script> を仕込みます
  //console.log("injecting script:", TARGET_ID);
  //InjectScript(INJECT_SCRIPT, TARGET_ID);
  // InjectScript() で仕込まれたデータを使って字幕データを fetch します
  FetchCaptionData();
}

function LoadBooleanSettings(){
  chrome.storage.sync.get(["isEnabled", "isStopIfNewSpeech", "isDisableSpeechIfSameLocaleVideo", "isDisableSpeechIfChaptionDisabled"], (result)=>{
    if(result?.isEnabled){
      isEnabled = true;
    }else{
      isEnabled = false;
      speechSynthesis.cancel();
    }
    if(result?.isStopIfNewSpeech){
      isStopIfNewSpeech = true;
    }else{
      isStopIfNewSpeech = false;
    }
    if(result?.isDisableSpeechIfSameLocaleVideo){
      isDisableSpeechIfSameLocaleVideo = true;
    }else{
      isDisableSpeechIfSameLocaleVideo = false;
    }
    if(result?.isDisableSpeechIfChaptionDisabled){
      isDisableSpeechIfChaptionDisabled = true;
    }else{
      isDisableSpeechIfChaptionDisabled = false;
    }
  });
}
function UpdateIsEnabled(isEnabled){
  chrome.storage.sync.set({"isEnabled": isEnabled});
}

chrome.runtime.onMessage.addListener(
  function(message, sender, sendResponse){
    //console.log("onMessage", message, sender, sendResponse);
    switch(message.type){
    case "KickSpeech":
      isEnabled = true;
      UpdateIsEnabled(isEnabled);
      LoadVoiceSettings();
      UpdateCaptionData();
      break;
    case "StopSpeech":
      isEnabled = false;
      UpdateIsEnabled(isEnabled);
      speechSynthesis.cancel();
      break;
    case "SettingsUpdated":
      LoadBooleanSettings();
      LoadVoiceSettings();
      UpdateCaptionData();
      break;
    case "LoadBooleanSettings":
      LoadBooleanSettings();
      break;
    default:
      break;
    }
  }
);

LoadBooleanSettings();
LoadVoiceSettings();
WatchYtplayerLoadForCaptionData();
// ビデオの再生位置を 0.25秒間隔 で確認するようにします
setInterval(CheckVideoCurrentTime, 250);
