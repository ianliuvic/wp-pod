import encode from './encode.js';
self.onmessage=async({data})=>{
 try{
  const png=new Blob([data.png],{type:'image/png'}),bitmap=await createImageBitmap(png);
  const c=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
  const pixels=ctx.getImageData(0,0,c.width,c.height);
  const output=await encode(pixels,{lossless:1,exact:1,near_lossless:100,quality:75,method:3});
  self.postMessage({id:data.id,output},[output]);
 }catch(e){self.postMessage({id:data.id,error:String(e.message||e)})}
};
