---

layout: 多线程笔试题

title: 多线程笔试题

tags: LeetCode

categories: Web

top: 46

path: /article/1716905190

abbrlink: 1716905190

date: 2024-05-28 22:05:58


---

# 多线程笔试题

判断顺序打印 1A2B3C1D2E3F...

~~~java
class Solution{
    
    public static char charStr = 'A';
    
    public static int index= 0;
    
    
    public static  void  main(String[] args){
        Runnable task = new Runnable(){
            
           @Override
            public void run(){
                synchronized(this){
                    
                    try{
                        int id = Integer.parseInt(Thread.currentThread().getName());
                        while(index < 26){
                            if(index % 3  ==  id -1){
                                System.out.println("当前线程id:"+(id)+ charStr++);
                                index++;
                                notifyAll();
                            }else{
                                
                                wait();
                            }
                        }
                        
                    }catch(Exception e){
                        
                       e.printStackTrace();
                        
                    }
                    
                    
                }
                
                
                
            }
        
            
        };
    	    new Thread(task,"1").start();
            new Thread(task,"2").start();
            new Thread(task,"3").start();
           
    }
        
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
}



~~~





